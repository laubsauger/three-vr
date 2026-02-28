import React, { useEffect, useRef, useState } from 'react';
import { WebXRFeatureName, WebXRLayers } from '@babylonjs/core';
import { useScene, useXrExperience } from 'reactylon';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { type AdvancedDynamicTexture } from '@babylonjs/gui';
import { Control } from '@babylonjs/gui/2D/controls/control';
import '@tensorflow/tfjs-backend-webgpu';
import BboxUtils, { type Rectangle } from './BboxUtils';

async function loop(
  video: HTMLVideoElement,
  model: cocoSsd.ObjectDetection,
  advancedDynamicTexture: AdvancedDynamicTexture
): Promise<Array<Rectangle>> {
  const preds = await model.detect(video);
  const { videoWidth: srcW, videoHeight: srcH } = video;
  const { width: viewW, height: viewH } = advancedDynamicTexture.getSize();
  const detections = preds.map((pred) =>
    BboxUtils.mapBboxToScreen(pred, srcW, srcH, viewW, viewH)
  );
  return detections;
}

const TITLE_HEIGHT = 50;

const Content: React.FC = () => {
  const scene = useScene();
  const xrExperience = useXrExperience();
  const [detections, setDetections] = useState<Array<Rectangle>>([]);
  const advancedDynamicTextureRef = useRef<AdvancedDynamicTexture>(null);

  useEffect(() => {
    const advancedDynamicTexture =
      advancedDynamicTextureRef.current as AdvancedDynamicTexture;

    const layers = xrExperience.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.LAYERS,
      'latest',
      {
        preferMultiviewOnInit: true,
      },
      true,
      false
    ) as WebXRLayers;

    xrExperience.baseExperience.onInitialXRPoseSetObservable.add(async () => {
      if (layers.attached) {
        layers.addFullscreenAdvancedDynamicTexture(advancedDynamicTexture);
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      console.log(devices);
      const rightCameraId = devices.find(
        (device) =>
          device.kind === 'videoinput' &&
          device.label === 'camera 2, facing back'
      )?.deviceId;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: 1280,
            height: 960,
            deviceId: rightCameraId,
          },
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();

        const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        //await model.detect(video); // warm-up

        let busy = false;
        scene.onBeforeRenderObservable.add(async () => {
          if (busy) return;
          busy = true;
          const detections = await loop(video, model, advancedDynamicTexture);
          setDetections(detections);
          setTimeout(() => (busy = false), 80); // ~12 Hz
        });
      } catch (e) {
        console.error(e);
      }
    });
  }, []);

  return (
    <advancedDynamicTexture
      ref={advancedDynamicTextureRef}
      kind="createFullscreenUI"
      createFullscreenUI={{ name: 'detections-overlay' }}
    >
      {detections.map(({ width, height, left, top, label, score }) => {
        return (
          <stackPanel
            key={label + score}
            leftInPixels={left}
            topInPixels={top - TITLE_HEIGHT}
            adaptHeightToChildren
            widthInPixels={width + 100}
            verticalAlignment={Control.VERTICAL_ALIGNMENT_TOP}
            horizontalAlignment={Control.HORIZONTAL_ALIGNMENT_LEFT}
          >
            <rectangle
              heightInPixels={TITLE_HEIGHT}
              background={'#87CEEB'}
              adaptWidthToChildren
              cornerRadiusX={20}
              cornerRadiusY={20}
              shadowBlur={7}
            >
              <textBlock
                text={label.toUpperCase()}
                color="black"
                fontSize={24}
                resizeToFit
                paddingLeftInPixels={30}
                paddingRightInPixels={30}
                shadowBlur={1}
              />
            </rectangle>
            <rectangle
              alpha={0.8}
              cornerRadius={20}
              widthInPixels={width}
              heightInPixels={height}
            />
          </stackPanel>
        );
      })}
    </advancedDynamicTexture>
  );
};

export default Content;
