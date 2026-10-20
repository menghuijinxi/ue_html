#include "blake3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char* WebBlake3Digest(int length, int mode, int split)
{
    static char hex[263];
    const char* key = "whats the Elvish word for friend";
    const char* context = "BLAKE3 2019-12-27 16:29:52 test vectors context";
    if (length < 0 || length > 102400 || mode < 0 || mode > 2 || split < 0)
        return "";
    unsigned char* input = malloc(length ? (size_t)length : 1);
    if (!input) return "";
    for (int i = 0; i < length; ++i) input[i] = (unsigned char)(i % 251);
    blake3_hasher hasher;
    if (mode == 0) blake3_hasher_init(&hasher);
    else if (mode == 1) blake3_hasher_init_keyed(&hasher, (const unsigned char*)key);
    else blake3_hasher_init_derive_key(&hasher, context);
    if (!split) blake3_hasher_update(&hasher, input, (size_t)length);
    else
        for (int offset = 0; offset < length; offset += split)
            blake3_hasher_update(&hasher, input + offset,
                (size_t)(length - offset < split ? length - offset : split));
    unsigned char digest[131];
    unsigned char short_digest[32];
    blake3_hasher_finalize(&hasher, digest, sizeof(digest));
    blake3_hasher_finalize(&hasher, short_digest, sizeof(short_digest));
    free(input);
    if (memcmp(digest, short_digest, sizeof(short_digest))) return "";
    for (int i = 0; i < 131; ++i) sprintf(hex + i * 2, "%02x", digest[i]);
    return hex;
}

int main(void)
{
    puts("P3_WEB_BLAKE3_READY");
    return 0;
}
