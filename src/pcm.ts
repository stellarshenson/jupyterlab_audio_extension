/**
 * Pure PCM helpers shared by the audio worklet and the unit tests.
 *
 * The wire contract (see docs/acc-crit-audio.md): signed 16-bit little-endian,
 * 16 kHz, mono; one frame = 20 ms of audio = 320 samples = 640 bytes.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
export const FRAME_BYTES = FRAME_SAMPLES * 2; // s16le -> 2 bytes per sample

/**
 * Convert Float32 samples in [-1, 1] to signed 16-bit little-endian PCM.
 *
 * The int16 range is asymmetric: -1.0 maps to -32768 and +1.0 to +32767.
 */
export function floatToS16LE(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) {
      s = 1;
    } else if (s < -1) {
      s = -1;
    }
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, Math.round(v), true);
  }
  return buffer;
}

/**
 * Accumulates Float32 samples and emits fixed-size s16le frames as they fill.
 *
 * Used by the Jest tests; the worklet re-implements the same math inline because it runs
 * in a separate module context that cannot import this file.
 */
export class Framer {
  private _buf = new Float32Array(FRAME_SAMPLES);
  private _filled = 0;

  push(chunk: Float32Array): ArrayBuffer[] {
    const frames: ArrayBuffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(
        FRAME_SAMPLES - this._filled,
        chunk.length - offset
      );
      this._buf.set(chunk.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;
      if (this._filled === FRAME_SAMPLES) {
        frames.push(floatToS16LE(this._buf));
        this._filled = 0;
      }
    }
    return frames;
  }
}

// Speaker wire contract: s16le, 48 kHz, 2 channels interleaved; 4 bytes per sample frame.
export const SPEAKER_SAMPLE_RATE = 48000;

/**
 * Convert interleaved stereo s16le PCM to one Float32 array per channel, in [-1, 1).
 *
 * The speaker worklet embeds this function's source, so it must not reference anything
 * outside its own body.
 */
export function s16leStereoToFloat32(
  pcm: ArrayBuffer
): [Float32Array, Float32Array] {
  const view = new DataView(pcm);
  const frames = pcm.byteLength >> 2;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(i * 4, true) / 0x8000;
    right[i] = view.getInt16(i * 4 + 2, true) / 0x8000;
  }
  return [left, right];
}

/**
 * Stereo ring buffer of the speaker player. It plays only once `prebuffer` frames are
 * queued, again after an underrun, outputs silence while it waits, and holds at most
 * `capacity` frames by dropping the oldest.
 *
 * The speaker worklet embeds this class's source, so it must not reference anything
 * outside its own body.
 */
export class SpeakerRing {
  constructor(prebuffer: number, capacity: number) {
    this._prebuffer = prebuffer;
    this._left = new Float32Array(capacity);
    this._right = new Float32Array(capacity);
  }

  push(left: Float32Array, right: Float32Array): void {
    const capacity = this._left.length;
    for (let i = 0; i < left.length; i++) {
      const end = (this._start + this._size) % capacity;
      this._left[end] = left[i];
      this._right[end] = right[i];
      if (this._size === capacity) {
        this._start = (this._start + 1) % capacity; // the write replaced the oldest frame
      } else {
        this._size++;
      }
    }
  }

  /** Fill one render quantum of output, or silence while prebuffering or on underrun. */
  pull(left: Float32Array, right: Float32Array): void {
    const n = left.length;
    if (!this._playing && this._size >= this._prebuffer) {
      this._playing = true;
    }
    if (!this._playing || this._size < n) {
      this._playing = false;
      left.fill(0);
      right.fill(0);
      return;
    }
    const capacity = this._left.length;
    for (let i = 0; i < n; i++) {
      left[i] = this._left[this._start];
      right[i] = this._right[this._start];
      this._start = (this._start + 1) % capacity;
    }
    this._size -= n;
  }

  private _prebuffer: number;
  private _left: Float32Array;
  private _right: Float32Array;
  private _start = 0;
  private _size = 0;
  private _playing = false;
}
