#ifndef RAYKIT_H
#define RAYKIT_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t *data;
    size_t len;
} RaykitBuffer;

typedef struct {
    uint64_t handle;
    RaykitBuffer metadata;
    RaykitBuffer data;
} RaykitResponse;

/* Return 0 for success, 1 for JSON error metadata, or 2 for a null output pointer. */
/* Buffers are byte spans. Release both with raykit_v1_free, even on return code 1. */
uint32_t raykit_v1_abi_version(void);
uint32_t raykit_v1_capabilities(RaykitResponse *out);
uint32_t raykit_v1_open(const uint8_t *bytes, size_t len, const uint8_t *options, size_t options_len, RaykitResponse *out);
/* Pass null/zero for both index spans for a fully read source. Indexed opens require a separately trusted SHA-256 pin. */
uint32_t raykit_v1_open_file(const uint8_t *utf8_path, size_t path_len, const uint8_t *manifest, size_t manifest_len, const uint8_t *pin, size_t pin_len, const uint8_t *options, size_t options_len, RaykitResponse *out);
/* The Unix descriptor is borrowed for the call. RayKit duplicates it and owns only the duplicate. */
uint32_t raykit_v1_open_descriptor(int32_t fd, const uint8_t *manifest, size_t manifest_len, const uint8_t *pin, size_t pin_len, const uint8_t *options, size_t options_len, RaykitResponse *out);
uint32_t raykit_v1_append(uint64_t handle, const uint8_t *bytes, size_t len, const uint8_t *options, size_t options_len, RaykitResponse *out);
uint32_t raykit_v1_append_file(uint64_t handle, const uint8_t *utf8_path, size_t path_len, const uint8_t *options, size_t options_len, RaykitResponse *out);
uint32_t raykit_v1_request(uint64_t handle, const uint8_t *command, size_t len, RaykitResponse *out);
void raykit_v1_close(uint64_t handle);
void raykit_v1_free(uint8_t *data, size_t len);
size_t raykit_v1_live_sessions(void);
size_t raykit_v1_live_buffers(void);

#ifdef __cplusplus
}
#endif
#endif
