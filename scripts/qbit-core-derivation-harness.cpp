// Generates qbit Core PQC derivation vectors from the pinned Core sources.
//
// This intentionally mirrors src/crypto/pqc.cpp:137-199 from
// Qbit-Org/qbit@7ebcddb622d6e639041f005a189b048ec2a221fe (v1.0.0), using Core's
// CHMAC_SHA256 and WriteLE32 helpers before passing the OKM to slh_dsa_keygen.

#include <crypto/common.h>
#include <crypto/hmac_sha256.h>
#include <crypto/sha256.h>

extern "C" {
#include <libbitcoinpqc/slh_dsa.h>
}

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr std::string_view PQC_HKDF_INFO_PREFIX{"qbit/sphincs+/1"};
constexpr char PQC_HKDF_SALT[] = "qbit-sphincs-v1";

struct FixtureCase {
    const char* name;
    const char* network;
    uint32_t purpose;
    uint32_t coin_type;
    uint32_t path_account;
    uint32_t path_change;
    uint32_t path_index;
    uint32_t hkdf_account;
    uint32_t hkdf_change;
    uint32_t hkdf_index;
    const char* descriptor_template;
    const char* core_behavior;
    const char* master_seed_hex;
    const char* message_hex;
    bool descriptor;
    bool boundary;
};

constexpr std::array<FixtureCase, 5> FIXTURE_CASES{{
    {
        "regtest_external_0",
        "regtest",
        87,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        "mr(pk(pqc(<xprv>/87h/1h/0h/0/*)))",
        "canonical_descriptor_generation",
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "716269742d7071632d64657269766174696f6e3a726567746573742d65787465726e616c2d30",
        true,
        false,
    },
    {
        "regtest_recovery_change_1_index_7",
        "regtest",
        87,
        1,
        0,
        1,
        7,
        0,
        1,
        7,
        "mr(pk(pqc(<xprv>/87h/1h/0h/1/*)))",
        "recovery_match_only",
        "f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff",
        "716269742d7071632d64657269766174696f6e3a726567746573742d6368616e67652d312d696e6465782d37",
        true,
        false,
    },
    {
        "mainnet_external_index_42",
        "mainnet",
        87,
        0,
        0,
        0,
        42,
        0,
        0,
        42,
        "mr(pk(pqc(<xprv>/87h/0h/0h/0/*)))",
        "canonical_descriptor_generation",
        "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
        "716269742d7071632d64657269766174696f6e3a6d61696e6e65742d65787465726e616c2d3432",
        true,
        false,
    },
    {
        "regtest_external_boundary_2147483647",
        "regtest",
        87,
        1,
        0,
        0,
        2147483647,
        0,
        0,
        2147483647,
        "mr(pk(pqc(<xprv>/87h/1h/0h/0/*)))",
        "canonical_descriptor_generation",
        "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100",
        "716269742d7071632d64657269766174696f6e3a726567746573742d65787465726e616c2d626f756e646172792d32313437343833363437",
        true,
        true,
    },
    {
        "direct_index_4294967295",
        "direct",
        87,
        1,
        0,
        0,
        4294967295U,
        0,
        0,
        4294967295U,
        "DerivePQCKey(master_seed, account=0, change=0, index=4294967295)",
        "primitive_only",
        "abcdef0123456789fedcba98765432100123456789abcdeff0e1d2c3b4a59687",
        "716269742d7071632d64657269766174696f6e3a6469726563742d696e6465782d34323934393637323935",
        false,
        true,
    },
}};

uint8_t HexDigit(char c)
{
    if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<uint8_t>(c - 'a' + 10);
    throw std::runtime_error("invalid lowercase hex input");
}

std::vector<unsigned char> ParseHex(std::string_view hex)
{
    if (hex.size() % 2 != 0) {
        throw std::runtime_error("invalid hex length");
    }

    std::vector<unsigned char> out(hex.size() / 2);
    for (size_t i = 0; i < out.size(); ++i) {
        out[i] = static_cast<unsigned char>((HexDigit(hex[i * 2]) << 4) | HexDigit(hex[i * 2 + 1]));
    }
    return out;
}

std::string HexStr(std::span<const unsigned char> bytes)
{
    static constexpr char HEX[] = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (const unsigned char byte : bytes) {
        out.push_back(HEX[byte >> 4]);
        out.push_back(HEX[byte & 0x0f]);
    }
    return out;
}

bool DeriveCoreOkm(
    std::span<const unsigned char> master_seed,
    uint32_t account,
    uint32_t change,
    uint32_t index,
    std::array<unsigned char, SLH_DSA_KEYGEN_RANDOM_DATA_MIN_SIZE>& random_data)
{
    if (master_seed.empty()) return false;

    std::array<unsigned char, CHMAC_SHA256::OUTPUT_SIZE> prk{};
    CHMAC_SHA256(reinterpret_cast<const unsigned char*>(PQC_HKDF_SALT), strlen(PQC_HKDF_SALT))
        .Write(master_seed.data(), master_seed.size())
        .Finalize(prk.data());

    std::array<unsigned char, PQC_HKDF_INFO_PREFIX.size() + 12> info{};
    std::copy(PQC_HKDF_INFO_PREFIX.begin(), PQC_HKDF_INFO_PREFIX.end(), info.begin());
    WriteLE32(info.data() + PQC_HKDF_INFO_PREFIX.size(), account);
    WriteLE32(info.data() + PQC_HKDF_INFO_PREFIX.size() + 4, change);
    WriteLE32(info.data() + PQC_HKDF_INFO_PREFIX.size() + 8, index);

    std::array<unsigned char, CHMAC_SHA256::OUTPUT_SIZE> block{};
    std::array<unsigned char, CHMAC_SHA256::OUTPUT_SIZE> previous{};
    size_t previous_size = 0;
    size_t offset = 0;
    uint8_t counter = 1;
    while (offset < random_data.size()) {
        CHMAC_SHA256 hmac(prk.data(), prk.size());
        if (previous_size > 0) {
            hmac.Write(previous.data(), previous_size);
        }
        hmac.Write(info.data(), info.size()).Write(&counter, 1).Finalize(block.data());

        const size_t copy_size = std::min(block.size(), random_data.size() - offset);
        std::copy_n(block.data(), copy_size, random_data.data() + offset);
        offset += copy_size;
        previous = block;
        previous_size = block.size();

        if (counter == std::numeric_limits<uint8_t>::max() && offset < random_data.size()) {
            return false;
        }
        ++counter;
    }

    return true;
}

std::string Sha256Hex(std::span<const unsigned char> bytes)
{
    std::array<unsigned char, CSHA256::OUTPUT_SIZE> digest{};
    CSHA256().Write(bytes.data(), bytes.size()).Finalize(digest.data());
    return HexStr(digest);
}

std::string DescriptorPath(const FixtureCase& c)
{
    return "m/" + std::to_string(c.purpose) + "h/" + std::to_string(c.coin_type) + "h/" +
        std::to_string(c.path_account) + "h/" + std::to_string(c.path_change) + "/" +
        std::to_string(c.path_index);
}

void WriteJsonString(std::ostream& out, std::string_view value)
{
    out << '"';
    for (const char ch : value) {
        if (ch == '"' || ch == '\\') {
            out << '\\' << ch;
        } else {
            out << ch;
        }
    }
    out << '"';
}

} // namespace

int main()
{
    try {
        std::cout << "[\n";
        for (size_t i = 0; i < FIXTURE_CASES.size(); ++i) {
            const FixtureCase& fixture_case = FIXTURE_CASES[i];
            const std::vector<unsigned char> master_seed = ParseHex(fixture_case.master_seed_hex);
            const std::vector<unsigned char> message = ParseHex(fixture_case.message_hex);

            std::array<unsigned char, SLH_DSA_KEYGEN_RANDOM_DATA_MIN_SIZE> okm{};
            if (!DeriveCoreOkm(master_seed, fixture_case.hkdf_account, fixture_case.hkdf_change, fixture_case.hkdf_index, okm)) {
                throw std::runtime_error(std::string("failed to derive OKM for ") + fixture_case.name);
            }

            std::array<unsigned char, SLH_DSA_PUBLIC_KEY_SIZE> public_key{};
            std::array<unsigned char, SLH_DSA_SECRET_KEY_SIZE> secret_key{};
            if (slh_dsa_keygen(public_key.data(), secret_key.data(), okm.data(), okm.size()) != 0) {
                throw std::runtime_error(std::string("slh_dsa_keygen failed for ") + fixture_case.name);
            }

            std::array<unsigned char, SLH_DSA_SIGNATURE_SIZE> signature{};
            size_t signature_size = signature.size();
            if (slh_dsa_sign(signature.data(), &signature_size, message.data(), message.size(), secret_key.data()) != 0 ||
                signature_size != signature.size() ||
                slh_dsa_verify(signature.data(), signature_size, message.data(), message.size(), public_key.data()) != 0) {
                throw std::runtime_error(std::string("SLH-DSA sign/verify failed for ") + fixture_case.name);
            }

            if (i != 0) std::cout << ",\n";
            std::cout << "  {\n";
            std::cout << "    \"name\": ";
            WriteJsonString(std::cout, fixture_case.name);
            std::cout << ",\n    \"network\": ";
            WriteJsonString(std::cout, fixture_case.network);
            std::cout << ",\n    \"descriptorTemplate\": ";
            WriteJsonString(std::cout, fixture_case.descriptor_template);
            std::cout << ",\n    \"coreBehavior\": ";
            WriteJsonString(std::cout, fixture_case.core_behavior);
            if (fixture_case.descriptor) {
                std::cout << ",\n    \"range\": [" << fixture_case.path_index << ", " << fixture_case.path_index << "],\n";
                std::cout << "    \"path\": {\"purpose\": " << fixture_case.purpose
                          << ", \"coinType\": " << fixture_case.coin_type
                          << ", \"account\": " << fixture_case.path_account
                          << ", \"change\": " << fixture_case.path_change
                          << ", \"index\": " << fixture_case.path_index << "},\n";
            } else {
                std::cout << ",\n";
            }
            std::cout << "    \"hkdf\": {\"account\": " << fixture_case.hkdf_account
                      << ", \"change\": " << fixture_case.hkdf_change
                      << ", \"index\": " << fixture_case.hkdf_index << "}";
            if (fixture_case.descriptor) {
                std::cout << ",\n    \"descriptorPath\": ";
                WriteJsonString(std::cout, DescriptorPath(fixture_case));
            }
            std::cout << ",\n    \"boundary\": " << (fixture_case.boundary ? "true" : "false") << ",\n";
            std::cout << "    \"masterSeedHex\": ";
            WriteJsonString(std::cout, fixture_case.master_seed_hex);
            std::cout << ",\n    \"messageHex\": ";
            WriteJsonString(std::cout, fixture_case.message_hex);
            std::cout << ",\n    \"keygenEntropyHex\": ";
            WriteJsonString(std::cout, HexStr(okm));
            std::cout << ",\n    \"publicKeyHex\": ";
            WriteJsonString(std::cout, HexStr(public_key));
            std::cout << ",\n    \"secretKeyHex\": ";
            WriteJsonString(std::cout, HexStr(secret_key));
            std::cout << ",\n    \"signatureSha256Hex\": ";
            WriteJsonString(std::cout, Sha256Hex(signature));
            std::cout << "\n  }";
        }
        std::cout << "\n]\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
    return 0;
}
