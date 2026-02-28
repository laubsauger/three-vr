import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import '@babylonjs/core/Materials/Node/Blocks';
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic';
import * as tf from '@tensorflow/tfjs';

registerBuiltInLoaders();

async function initBackend() {
  try {
    //await tf.setBackend('webgpu');
    await tf.setBackend('webgl');
  } catch {
    try {
      await tf.setBackend('webgl');
    } catch {
      await tf.setBackend('wasm');
    }
  }
  await tf.ready();
  console.log('TF backend:', tf.getBackend());
}

(async () => {
  await initBackend();
  const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
  );
  root.render(<App />);
})();
