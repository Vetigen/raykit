#include "raykit.h"
#include <stdio.h>
#include <string.h>

static void release_reply(RaykitResponse *reply) {
    raykit_v1_free(reply->metadata.data, reply->metadata.len);
    raykit_v1_free(reply->data.data, reply->data.len);
}

int main(int argc, char **argv) {
    if (argc < 4 || argc > 5 || raykit_v1_abi_version() != 1) return 2;
    RaykitResponse reply = {0};
    uint32_t status = raykit_v1_open_file(
        (const uint8_t *)argv[1], strlen(argv[1]), NULL, 0, NULL, 0,
        (const uint8_t *)argv[2], strlen(argv[2]), &reply);
    const uint64_t handle = reply.handle;
    if (status) {
        fwrite(reply.metadata.data, 1, reply.metadata.len, stderr);
        release_reply(&reply);
        return 1;
    }
    release_reply(&reply);
    status = raykit_v1_request(handle, (const uint8_t *)argv[3], strlen(argv[3]), &reply);
    if (reply.metadata.len) fwrite(reply.metadata.data, 1, reply.metadata.len, stdout);
    if (!status && argc == 5) {
        FILE *output = fopen(argv[4], "wb");
        if (!output) {
            status = 2;
        } else {
            if (fwrite(reply.data.data, 1, reply.data.len, output) != reply.data.len) status = 2;
            if (fclose(output)) status = 2;
        }
    }
    release_reply(&reply);
    raykit_v1_close(handle);
    if (raykit_v1_live_sessions() || raykit_v1_live_buffers()) return 2;
    return status ? 1 : 0;
}
