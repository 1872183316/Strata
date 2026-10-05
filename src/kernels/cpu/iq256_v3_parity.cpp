// src/kernels/cpu/iq256_v3_parity.cpp - IQ2_S and IQ3_S gate/up rows with the per-block decode (iq256_gu_rows)
// against the kernels before it (iq256_gu_rows_reference), bit for bit, for 1..8 tokens, plus each one's time on one
// thread.  No GPU, no model: random blocks (fp16 scales in a sane range) in the expert layout of a native pack
// (gate rows, up rows), activations quantized as the engine does (native_quant_act).
//
//     iq256_v3_parity            exit 1 on any difference
#include "strata/kernels/cpu/expert_layout.hpp"
#include "strata/kernels/cpu/iq_avx2.hpp"
#include "strata/kernels/cpu/native_expert.hpp"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

namespace cpu = strata::kernels::cpu;

int main() {
    if (!cpu::cpu_avx2_ok()) {
        std::printf("iq256_v3_parity: no AVX2 on this CPU, skipped\n");
        return 0;
    }
    constexpr int H = 2560, FF = 640, EXPERTS = 4;
    int failures = 0;
    for (const int type : {22, 21}) {
        const size_t block = type == 22 ? 82 : 110;
        cpu::NativeFmt f;
        std::string err;
        if (!cpu::native_fmt(type, 20, H, FF, f, err)) {
            std::printf("native_fmt: %s\n", err.c_str());
            return 1;
        }
        std::mt19937 rng(1000 + type);
        std::vector<uint8_t> w((size_t) EXPERTS * f.bytes);
        for (auto& b : w) b = (uint8_t) rng();
        for (int e = 0; e < EXPERTS; ++e)
            for (size_t b = 0; b + block <= f.down_off; b += block) {   // fp16 d in [2^-6, 2^-2)
                const uint16_t d = (uint16_t) (((9 + rng() % 4) << 10) | (rng() & 1023));
                std::memcpy(&w[(size_t) e * f.bytes + b], &d, 2);
            }
        std::vector<std::vector<uint8_t>> act(8, std::vector<uint8_t>(cpu::kNativeActBytes));
        const void* a[8];
        std::normal_distribution<float> nd(0.f, 1.f);
        for (int t = 0; t < 8; ++t) {
            std::vector<float> x(H);
            for (auto& v : x) v = nd(rng);
            cpu::native_quant_act(f, x.data(), act[t].data());
            a[t] = act[t].data();
        }
        long diff = 0, rows = 0;
        std::vector<float> o1(8 * FF), o2(8 * FF);
        float* p1[8];
        float* p2[8];
        for (int t = 0; t < 8; ++t) { p1[t] = &o1[(size_t) t * FF]; p2[t] = &o2[(size_t) t * FF]; }
        for (int nt = 1; nt <= 8; ++nt)
            for (int e = 0; e < EXPERTS; ++e) {
                const uint8_t* blob = &w[(size_t) e * f.bytes];
                cpu::iq256_gu_rows(type, blob, f.gu_row, f.up_off, H, a, nt, p1, 0, FF);
                cpu::iq256_gu_rows_reference(type, blob, f.gu_row, f.up_off, H, a, nt, p2, 0, FF);
                for (int t = 0; t < nt; ++t)
                    for (int r = 0; r < FF; ++r, ++rows)
                        if (std::memcmp(&o1[(size_t) t * FF + r], &o2[(size_t) t * FF + r], 4) != 0) {
                            if (diff < 4)
                                std::printf("  type %d, %d tokens, expert %d, token %d, row %d: %.9g vs %.9g\n", type,
                                            nt, e, t, r, o1[(size_t) t * FF + r], o2[(size_t) t * FF + r]);
                            ++diff;
                        }
            }
        // one thread, the experts in cache: ms per expert's gate/up at 1 and 3 tokens
        double ms[2][2];
        for (int k = 0; k < 2; ++k)
            for (int which = 0; which < 2; ++which) {
                const int nt = k == 0 ? 1 : 3, reps = 40;
                const auto t0 = std::chrono::steady_clock::now();
                for (int i = 0; i < reps; ++i) {
                    const uint8_t* blob = &w[(size_t) (i % EXPERTS) * f.bytes];
                    if (which == 0) cpu::iq256_gu_rows(type, blob, f.gu_row, f.up_off, H, a, nt, p1, 0, FF);
                    else cpu::iq256_gu_rows_reference(type, blob, f.gu_row, f.up_off, H, a, nt, p2, 0, FF);
                }
                ms[k][which] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / reps;
            }
        std::printf("%s: %ld of %ld rows differ; one thread, ms per expert's gate/up: 1 token %.3f (before %.3f), "
                    "3 tokens %.3f (before %.3f)\n", type == 22 ? "IQ2_S" : "IQ3_S", diff, rows, ms[0][0], ms[0][1],
                    ms[1][0], ms[1][1]);
        failures += diff != 0;
    }
    return failures ? 1 : 0;
}
