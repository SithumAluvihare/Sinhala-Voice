// AudioWorklet: takes mic audio at the context's native rate, downsamples it
// to 16 kHz mono, converts to 16-bit PCM and posts ~100 ms chunks to the page.

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz, as the Live API docs recommend

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.buf = new Int16Array(CHUNK_SAMPLES);
    this.len = 0;
    this.sq = 0; // running sum of squares for the level meter
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      // Mix to mono.
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      s /= channels;

      // Box-filter downsampling: average every `step` input samples.
      this.sum += s;
      this.count++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.sq += v * v;
        this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;

        if (this.len === CHUNK_SAMPLES) {
          const rms = Math.sqrt(this.sq / CHUNK_SAMPLES);
          const out = this.buf;
          this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
          this.buf = new Int16Array(CHUNK_SAMPLES);
          this.len = 0;
          this.sq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
