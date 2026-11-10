import { s16leStereoToFloat32, SPEAKER_SAMPLE_RATE, SpeakerRing } from './pcm';

/**
 * AudioWorklet processor that plays the speaker stream: each message is an ArrayBuffer of
 * s16le 48 kHz stereo PCM, queued in a ring buffer and played on the 48 kHz context.
 *
 * The source is shipped as a string and loaded via a Blob URL, as src/worklet.ts does.
 * It embeds the tested helpers from pcm.ts by their source text.
 */

export const SPEAKER_PROCESSOR_NAME = 'voice-speaker-processor';

const SPEAKER_WORKLET_SOURCE = `
const s16leStereoToFloat32 = ${s16leStereoToFloat32};
const SpeakerRing = ${SpeakerRing};

class VoiceSpeakerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 100 ms prebuffer, 500 ms cap
    this._ring = new SpeakerRing(${SPEAKER_SAMPLE_RATE / 10}, ${SPEAKER_SAMPLE_RATE / 2});
    this.port.onmessage = ev => {
      const [left, right] = s16leStereoToFloat32(ev.data);
      this._ring.push(left, right);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    this._ring.pull(output[0], output[1]);
    return true;
  }
}

registerProcessor('${SPEAKER_PROCESSOR_NAME}', VoiceSpeakerProcessor);
`;

/**
 * Create an object URL for the speaker worklet module. Callers should revoke it once the
 * module has been added.
 */
export function speakerWorkletModuleUrl(): string {
  const blob = new Blob([SPEAKER_WORKLET_SOURCE], {
    type: 'application/javascript'
  });
  return URL.createObjectURL(blob);
}
