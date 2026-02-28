import React from 'react';
import { Engine } from 'reactylon/web';
import { Scene } from 'reactylon';
import Content from './Content';

const App: React.FC = () => {
  return (
    <Engine>
      <Scene
        onSceneReady={(scene) =>
          scene.createDefaultCameraOrLight(true, undefined, true)
        }
        xrDefaultExperienceOptions={{
          disableHandTracking: true,
          disablePointerSelection: true,
          inputOptions: {
            doNotLoadControllerMeshes: true,
          },
          uiOptions: {
            sessionMode: 'immersive-ar',
          },
        }}
      >
        <Content />
      </Scene>
    </Engine>
  );
};

export default App;
