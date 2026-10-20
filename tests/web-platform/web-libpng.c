#include "png.h"
#include "pngstruct.h"
#include "pnginfo.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    unsigned char bytes[262144];
    size_t size;
    size_t offset;
} Buffer;

static void write_bytes(png_structp png, png_bytep bytes, png_size_t length)
{
    Buffer* buffer = png_get_io_ptr(png);
    if (length > sizeof(buffer->bytes) - buffer->size) png_error(png, "Output overflow");
    memcpy(buffer->bytes + buffer->size, bytes, length);
    buffer->size += length;
}

static void read_bytes(png_structp png, png_bytep bytes, png_size_t length)
{
    Buffer* buffer = png_get_io_ptr(png);
    if (length > buffer->size - buffer->offset) png_error(png, "Truncated input");
    memcpy(bytes, buffer->bytes + buffer->offset, length);
    buffer->offset += length;
}

static void error_callback(png_structp png, png_const_charp message)
{
    (void)message;
    png_longjmp(png, 1);
}

static void warning_callback(png_structp png, png_const_charp message)
{
    (void)png;
    (void)message;
}

static int decode(Buffer* buffer, const unsigned char* expected, int width, int height, int depth)
{
    png_structp png = png_create_read_struct_2(PNG_LIBPNG_VER_STRING, NULL,
        error_callback, warning_callback, NULL, NULL, NULL);
    if (!png) return 0;
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_read_struct(&png, NULL, NULL); return 0; }
    if (setjmp(png_jmpbuf(png))) { png_destroy_read_struct(&png, &info, NULL); return 0; }
    buffer->offset = 0;
    png_set_read_fn(png, buffer, read_bytes);
    png_set_crc_action(png, PNG_CRC_ERROR_QUIT, PNG_CRC_ERROR_QUIT);
    png_read_info(png, info);
    if ((int)info->width != width || (int)info->height != height ||
        info->bit_depth != depth || info->color_type != PNG_COLOR_TYPE_RGBA)
        png_error(png, "Image header mismatch");
    png_textp text = NULL;
    if (png_get_text(png, info, &text, NULL) != 1 ||
        strcmp(text[0].key, "UEWeb") || strcmp(text[0].text, "portable-1.6.44"))
        png_error(png, "Metadata mismatch");
    png_read_update_info(png, info);
    const size_t stride = (size_t)width * 4 * (depth / 8);
    unsigned char row[1024];
    if (stride > sizeof(row)) png_error(png, "Row overflow");
    for (int y = 0; y < height; ++y)
    {
        png_read_row(png, row, NULL);
        if (memcmp(row, expected + y * stride, stride)) png_error(png, "Pixel mismatch");
    }
    png_read_end(png, info);
    png_destroy_read_struct(&png, &info, NULL);
    return 1;
}

static int round_trip(int width, int height, int depth)
{
    Buffer* buffer = calloc(1, sizeof(Buffer));
    const size_t stride = (size_t)width * 4 * (depth / 8);
    unsigned char* pixels = malloc(stride * height);
    png_bytep* rows = malloc((size_t)height * sizeof(png_bytep));
    if (!buffer || !pixels || !rows) { free(buffer); free(pixels); free(rows); return 0; }
    for (size_t i = 0; i < stride * height; ++i) pixels[i] = (unsigned char)((i * 37 + i / 7) % 256);
    for (int y = 0; y < height; ++y) rows[y] = pixels + y * stride;
    png_structp png = png_create_write_struct_2(PNG_LIBPNG_VER_STRING, NULL,
        error_callback, warning_callback, NULL, NULL, NULL);
    png_infop info = png ? png_create_info_struct(png) : NULL;
    int pass = 0;
    if (!png || !info) goto cleanup;
    if (setjmp(png_jmpbuf(png))) goto cleanup;
    png_set_write_fn(png, buffer, write_bytes, NULL);
    png_set_IHDR(png, info, width, height, depth, PNG_COLOR_TYPE_RGBA,
        PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_text text = {0};
    text.compression = PNG_TEXT_COMPRESSION_NONE;
    text.key = "UEWeb";
    text.text = "portable-1.6.44";
    png_set_text(png, info, &text, 1);
    png_set_rows(png, info, rows);
    png_write_png(png, info, PNG_TRANSFORM_IDENTITY, NULL);
    pass = decode(buffer, pixels, width, height, depth);
    if (pass)
    {
        // Preserve PNG framing and corrupt the IDAT payload to test error recovery.
        size_t chunk = 8;
        int corrupted = 0;
        while (chunk + 12 <= buffer->size)
        {
            const unsigned char* p = buffer->bytes + chunk;
            const size_t length = (size_t)p[0] << 24 | (size_t)p[1] << 16 | (size_t)p[2] << 8 | p[3];
            if (length > buffer->size - chunk - 12) break;
            if (length && !memcmp(p + 4, "IDAT", 4))
            {
                buffer->bytes[chunk + 8 + length / 2] ^= 0x20;
                corrupted = 1;
                break;
            }
            chunk += length + 12;
        }
        pass = corrupted && !decode(buffer, pixels, width, height, depth);
    }
cleanup:
    if (png) png_destroy_write_struct(&png, info ? &info : NULL);
    free(rows);
    free(pixels);
    free(buffer);
    return pass;
}

int main(void)
{
    const int cases[4][3] = {{1, 1, 8}, {31, 17, 8}, {128, 65, 8}, {19, 7, 16}};
    for (int i = 0; i < 4; ++i)
        if (!round_trip(cases[i][0], cases[i][1], cases[i][2])) return 1;
    puts("P3_LIBPNG_RESULT {\"pass\":true,\"cases\":4,\"depths\":[8,16],\"metadata\":true,\"corruptRejected\":true,\"checks\":8}");
    return 0;
}
