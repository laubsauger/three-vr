import * as cocoSsd from '@tensorflow-models/coco-ssd';

export type Rectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
  score: number;
  label: string;
};

class BboxUtils {
  private static fitContain(
    srcW: number,
    srcH: number,
    viewW: number,
    viewH: number
  ) {
    const scale = Math.min(viewW / srcW, viewH / srcH);
    return {
      scale,
      padX: (viewW - srcW * scale) / 2,
      padY: (viewH - srcH * scale) / 2,
    };
  }

  static mapBboxToScreen(
    detection: cocoSsd.DetectedObject,
    srcW: number,
    srcH: number,
    viewW: number,
    viewH: number
  ): Rectangle {
    const { bbox, score, class: label } = detection;
    const [x, y, w, h] = bbox;
    const { scale, padX, padY } = this.fitContain(srcW, srcH, viewW, viewH);
    const TOP_OFFSET = 250;
    return {
      left: padX + x * scale,
      top: padY + y * scale + TOP_OFFSET,
      width: w * scale,
      height: h * scale,
      label,
      score,
    };
  }
}

export default BboxUtils;
