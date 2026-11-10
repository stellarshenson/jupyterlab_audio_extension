import {
  floatToS16LE,
  Framer,
  FRAME_BYTES,
  FRAME_SAMPLES,
  s16leStereoToFloat32,
  SpeakerRing
} from '../pcm';

describe('floatToS16LE', () => {
  it('maps full scale to the int16 range, little-endian (B2)', () => {
    const buf = floatToS16LE(Float32Array.from([1, -1, 0, 0.5]));
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(8);
    expect(view.getInt16(0, true)).toBe(32767); // +1.0 -> 0x7FFF
    expect(view.getInt16(2, true)).toBe(-32768); // -1.0 -> -0x8000
    expect(view.getInt16(4, true)).toBe(0);
    expect(view.getInt16(6, true)).toBe(Math.round(0.5 * 0x7fff));
    // little-endian byte order for +1.0 (0x7FFF): low byte first
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x7f);
  });

  it('clamps out-of-range samples', () => {
    const view = new DataView(floatToS16LE(Float32Array.from([2, -2])));
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });
});

describe('Framer', () => {
  it('emits a fixed-size frame only once full (B3)', () => {
    const framer = new Framer();
    expect(framer.push(new Float32Array(FRAME_SAMPLES - 1))).toHaveLength(0);
    const frames = framer.push(new Float32Array(1));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(FRAME_BYTES);
  });

  it('splits a long chunk into whole frames and keeps the remainder', () => {
    const framer = new Framer();
    const frames = framer.push(new Float32Array(FRAME_SAMPLES * 2 + 5));
    expect(frames).toHaveLength(2);
    frames.forEach(f => expect(f.byteLength).toBe(FRAME_BYTES));
    // the 5 leftover samples are buffered; one more near-frame completes it
    expect(framer.push(new Float32Array(FRAME_SAMPLES - 5))).toHaveLength(1);
  });
});

describe('s16leStereoToFloat32', () => {
  it('splits interleaved s16le stereo into channels scaled to [-1, 1)', () => {
    // two frames, little-endian: (L 0x7FFF, R 0x8000), (L 0x4000, R 0xC000)
    const pcm = Uint8Array.from([
      0xff, 0x7f, 0x00, 0x80, 0x00, 0x40, 0x00, 0xc0
    ]);
    const [left, right] = s16leStereoToFloat32(pcm.buffer);
    expect(Array.from(left)).toEqual([32767 / 32768, 0.5]);
    expect(Array.from(right)).toEqual([-1, -0.5]);
  });
});

describe('SpeakerRing', () => {
  // prebuffer 4 frames, capacity 8 frames, render quantum 2 frames
  const pull = (ring: SpeakerRing): number[][] => {
    const left = new Float32Array(2).fill(9);
    const right = new Float32Array(2).fill(9);
    ring.pull(left, right);
    return [Array.from(left), Array.from(right)];
  };
  const push = (ring: SpeakerRing, values: number[]): void =>
    ring.push(
      Float32Array.from(values),
      Float32Array.from(values.map(v => -v))
    );

  it('stays silent until the prebuffer is full, then plays in order', () => {
    const ring = new SpeakerRing(4, 8);
    push(ring, [1, 2, 3]);
    expect(pull(ring)).toEqual([
      [0, 0],
      [0, 0]
    ]);
    push(ring, [4]);
    expect(pull(ring)).toEqual([
      [1, 2],
      [-1, -2]
    ]);
    expect(pull(ring)).toEqual([
      [3, 4],
      [-3, -4]
    ]);
  });

  it('outputs silence on an underrun and prebuffers again before playing', () => {
    const ring = new SpeakerRing(4, 8);
    push(ring, [1, 2, 3, 4, 5]);
    pull(ring);
    pull(ring);
    expect(pull(ring)).toEqual([
      [0, 0],
      [0, 0]
    ]); // one frame left: underrun
    push(ring, [6, 7]);
    expect(pull(ring)).toEqual([
      [0, 0],
      [0, 0]
    ]); // three frames queued, below the prebuffer
    push(ring, [8]);
    expect(pull(ring)).toEqual([
      [5, 6],
      [-5, -6]
    ]);
  });

  it('keeps at most its capacity by dropping the oldest frames', () => {
    const ring = new SpeakerRing(4, 8);
    push(ring, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([pull(ring), pull(ring), pull(ring), pull(ring)]).toEqual([
      [
        [3, 4],
        [-3, -4]
      ],
      [
        [5, 6],
        [-5, -6]
      ],
      [
        [7, 8],
        [-7, -8]
      ],
      [
        [9, 10],
        [-9, -10]
      ]
    ]);
    expect(pull(ring)).toEqual([
      [0, 0],
      [0, 0]
    ]);
  });
});
