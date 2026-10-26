#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "libbitcoinpqc/bitcoinpqc.h"
#include "libbitcoinpqc/slh_dsa.h"

int qbit_pqc_public_key_size(void) {
    return (int)bitcoin_pqc_public_key_size();
}

int qbit_pqc_secret_key_size(void) {
    return (int)bitcoin_pqc_secret_key_size();
}

int qbit_pqc_signature_size(void) {
    return (int)bitcoin_pqc_signature_size();
}

int qbit_pqc_keygen_entropy_min_size(void) {
    return SLH_DSA_KEYGEN_RANDOM_DATA_MIN_SIZE;
}

int qbit_pqc_keygen(
    uint8_t *public_key_out,
    uint8_t *secret_key_out,
    const uint8_t *entropy,
    size_t entropy_len
) {
    if (!public_key_out || !secret_key_out || !entropy) {
        return BITCOIN_PQC_ERROR_BAD_ARG;
    }

    bitcoin_pqc_keypair_t keypair = {0};
    bitcoin_pqc_error_t rc = bitcoin_pqc_keygen(&keypair, entropy, entropy_len);
    if (rc != BITCOIN_PQC_OK) {
        return rc;
    }

    memcpy(public_key_out, keypair.public_key, bitcoin_pqc_public_key_size());
    memcpy(secret_key_out, keypair.secret_key, bitcoin_pqc_secret_key_size());
    bitcoin_pqc_keypair_free(&keypair);
    return BITCOIN_PQC_OK;
}

int qbit_pqc_secret_key_validate(const uint8_t *secret_key, size_t secret_key_len) {
    return bitcoin_pqc_secret_key_validate(secret_key, secret_key_len);
}

int qbit_pqc_sign(
    uint8_t *signature_out,
    const uint8_t *secret_key,
    const uint8_t *message,
    size_t message_len
) {
    if (!signature_out || !secret_key || (!message && message_len != 0)) {
        return BITCOIN_PQC_ERROR_BAD_ARG;
    }

    bitcoin_pqc_signature_t signature = {0};
    bitcoin_pqc_error_t rc = bitcoin_pqc_sign(
        secret_key,
        bitcoin_pqc_secret_key_size(),
        message,
        message_len,
        &signature
    );
    if (rc != BITCOIN_PQC_OK) {
        return rc;
    }

    memcpy(signature_out, signature.signature, bitcoin_pqc_signature_size());
    bitcoin_pqc_signature_free(&signature);
    return BITCOIN_PQC_OK;
}

int qbit_pqc_sign_with_stats(
    uint8_t *signature_out,
    uint32_t *stats_out,
    const uint8_t *secret_key,
    const uint8_t *message,
    size_t message_len
) {
    if (!signature_out || !stats_out || !secret_key || (!message && message_len != 0)) {
        return BITCOIN_PQC_ERROR_BAD_ARG;
    }

    bitcoin_pqc_signature_t signature = {0};
    bitcoin_pqc_sign_stats_t stats = {0};
    bitcoin_pqc_error_t rc = bitcoin_pqc_sign_with_stats(
        secret_key,
        bitcoin_pqc_secret_key_size(),
        message,
        message_len,
        &signature,
        &stats
    );

    stats_out[0] = stats.forsc_attempts;
    stats_out[1] = stats.forsc_max_attempts;
    for (uint32_t i = 0; i < BITCOIN_PQC_SIGN_WOTSC_LAYERS; ++i) {
        stats_out[2 + i] = stats.wotsc_attempts[i];
    }
    stats_out[7] = stats.wotsc_layer_count;
    stats_out[8] = stats.wotsc_max_attempts;
    stats_out[9] = stats.wotsc_max_observed_attempts;
    stats_out[10] = stats.cap_exceeded;

    if (rc != BITCOIN_PQC_OK) {
        return rc;
    }

    memcpy(signature_out, signature.signature, bitcoin_pqc_signature_size());
    bitcoin_pqc_signature_free(&signature);
    return BITCOIN_PQC_OK;
}

int qbit_pqc_verify(
    const uint8_t *public_key,
    const uint8_t *message,
    size_t message_len,
    const uint8_t *signature,
    size_t signature_len
) {
    return bitcoin_pqc_verify(
        public_key,
        bitcoin_pqc_public_key_size(),
        message,
        message_len,
        signature,
        signature_len
    );
}
