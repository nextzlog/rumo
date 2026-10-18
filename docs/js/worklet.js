// AudioWorklet processor: forwards the microphone signal (first channel) to the
// decoder worker through a MessagePort, in batches of 8 render quanta (1024
// samples) to keep message overhead low.  Decoding is block-size independent.
class CwTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.buf = new Float32Array(1024);
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data && e.data.port) this.out = e.data.port; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.out) {
      let i = 0;
      while (i < ch.length) {
        const k = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k;
        i += k;
        if (this.n === this.buf.length) {
          this.out.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("cw-tap", CwTap);
