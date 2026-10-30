import './styles.css';
import { evaluateConfig } from './config-state';
import exampleConfig from '../../config/extension.example.json';
import type { ExtensionConfig } from '../types/config';
import type { PongMessage, WorkerOutMessage } from '../runtime/export-worker';

export interface SmokeResult {
  done: boolean;
  configStatus: string;
  isConfigured: boolean;
  signInDisabled: boolean;
  workerPong: PongMessage | null;
  error: string | null;
}

declare global {
  interface Window {
    __T07_SMOKE__?: SmokeResult;
  }
}

export function initApp(container: HTMLElement, config: ExtensionConfig = exampleConfig as ExtensionConfig): Worker {
  const configEvaluation = evaluateConfig(config);

  const statusContainer = document.createElement('div');
  statusContainer.id = 'config-status';

  if (!configEvaluation.isConfigured) {
    statusContainer.className = 'banner banner-warning';
    statusContainer.setAttribute('role', 'alert');

    const title = document.createElement('strong');
    title.id = 'status-code';
    title.textContent = configEvaluation.errorCode || 'CONFIG_REQUIRED';

    const desc = document.createElement('p');
    desc.id = 'status-message';
    desc.textContent = `${configEvaluation.message} Sign-in and network extractions are disabled in this offline build.`;

    statusContainer.appendChild(title);
    statusContainer.appendChild(desc);
  } else {
    statusContainer.className = 'banner banner-success';
    statusContainer.textContent = `Configured with client ID: ${configEvaluation.clientId}`;
  }

  container.appendChild(statusContainer);

  const actionSection = document.createElement('section');
  actionSection.className = 'action-section';

  const signInBtn = document.createElement('button');
  signInBtn.id = 'btn-signin';
  signInBtn.textContent = 'Sign In with Google';
  // Keep sign-in explicitly disabled in this scaffold until T17 implementation
  signInBtn.disabled = true;
  if (!configEvaluation.isConfigured) {
    signInBtn.title = 'Sign-in disabled: configuration required.';
  } else {
    signInBtn.title = 'Sign-in implementation pending (feature not implemented until T17).';
  }
  actionSection.appendChild(signInBtn);
  container.appendChild(actionSection);

  const smokeSection = document.createElement('section');
  smokeSection.className = 'smoke-panel';
  const smokeHeading = document.createElement('h2');
  smokeHeading.textContent = 'Local Runtime Status';
  const smokeOutput = document.createElement('pre');
  smokeOutput.id = 'smoke-output';
  smokeOutput.textContent = 'Initializing local runtime...';
  smokeSection.appendChild(smokeHeading);
  smokeSection.appendChild(smokeOutput);
  container.appendChild(smokeSection);

  window.__T07_SMOKE__ = {
    done: false,
    configStatus: configEvaluation.errorCode || 'CONFIGURED',
    isConfigured: configEvaluation.isConfigured,
    signInDisabled: signInBtn.disabled,
    workerPong: null,
    error: null
  };

  // Launch dedicated local worker
  const worker = new Worker(new URL('../runtime/export-worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
    const data = event.data;
    if (data.type === 'PONG') {
      smokeOutput.textContent = `Local worker verified: ${data.echo} (id: ${data.id})`;
      window.__T07_SMOKE__ = {
        done: true,
        configStatus: configEvaluation.errorCode || 'CONFIGURED',
        isConfigured: configEvaluation.isConfigured,
        signInDisabled: signInBtn.disabled,
        workerPong: data,
        error: null
      };
    } else {
      const err = data.type === 'ERROR' ? data.error : 'Unexpected worker message';
      smokeOutput.textContent = `Local worker error: ${err}`;
      window.__T07_SMOKE__ = {
        done: true,
        configStatus: configEvaluation.errorCode || 'CONFIGURED',
        isConfigured: configEvaluation.isConfigured,
        signInDisabled: signInBtn.disabled,
        workerPong: null,
        error: err
      };
    }
  };

  worker.onerror = (err) => {
    smokeOutput.textContent = `Local worker error: ${err.message || 'Worker failed to load'}`;
    window.__T07_SMOKE__ = {
      done: true,
      configStatus: configEvaluation.errorCode || 'CONFIGURED',
      isConfigured: configEvaluation.isConfigured,
      signInDisabled: signInBtn.disabled,
      workerPong: null,
      error: err.message || 'Worker runtime error'
    };
  };

  // Dispatch deterministic smoke ping
  worker.postMessage({ type: 'PING', id: 'smoke-ping-1', payload: 'T07_DET_PING' });

  return worker;
}

const root = document.getElementById('app-root');
if (root) {
  initApp(root);
}
