import { Signal } from '@lumino/signaling';

import type { VoiceCapture, VoiceCaptureState } from '../voice-capture';

import { VoiceStatus } from '../status';

// ui-components pulls ESM-only @jupyter/react-components, which Jest cannot load.
jest.mock('@jupyterlab/ui-components', () => ({
  LabIcon: class {
    element({ container }: { container: HTMLElement }): HTMLElement {
      container.appendChild(
        document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      );
      return container;
    }
  }
}));

/** The model surface VoiceStatus reads; state and message are set per case. */
class Model {
  state: VoiceCaptureState = 'idle';
  message = '';
  readonly stateChanged = new Signal<this, VoiceCaptureState>(this);
}

function create(state: VoiceCaptureState, message = ''): VoiceStatus {
  const model = new Model();
  model.state = state;
  model.message = message;
  return new VoiceStatus(model as unknown as VoiceCapture);
}

const CASES: ReadonlyArray<[VoiceCaptureState, string]> = [
  ['idle', 'Disconnected - Voice capture off - click to start'],
  ['connecting', 'Connecting - Voice capture connecting...'],
  ['streaming', 'Connected - Voice capture on - streaming to server'],
  ['error', 'Error - Voice capture error']
];

describe('VoiceStatus', () => {
  it.each(CASES)(
    'ACC-MIC-70-NO-LABEL: %s shows no visible text and the state word in the tooltip',
    (state, title) => {
      const widget = create(state);

      expect(widget.node.textContent).toBe('');
      expect(widget.node.querySelector('.jp-VoiceCapture-label')).toBeNull();
      expect(widget.node.title).toBe(title);
      expect(widget.node.dataset.vcState).toBe(state);

      widget.dispose();
    }
  );

  it('ACC-MIC-70-NO-LABEL: the error tooltip puts the model message after the state word', () => {
    const widget = create('error', 'Microphone permission denied.');

    expect(widget.node.title).toBe('Error - Microphone permission denied.');

    widget.dispose();
  });
});
