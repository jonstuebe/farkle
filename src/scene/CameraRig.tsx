import { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "three";
import { RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

/** What the camera should keep in frame: the tray, its rail, and a small margin. */
const FRAME_HALF_WIDTH = TRAY_WIDTH / 2 + RAIL_THICKNESS + 0.5;
const FRAME_HALF_DEPTH = TRAY_DEPTH / 2 + RAIL_THICKNESS + 0.5;
/** Camera elevation above the table plane, in radians (steep enough to read every top face). */
const CAMERA_PITCH = (58 * Math.PI) / 180;
/** Look slightly in front of centre so the HUD at the bottom doesn't cover the tray. */
const LOOK_AT_Z = 0.7;

/** Keeps the whole tray in view at any aspect ratio (wide desktop through portrait phone). */
export function CameraRig() {
  const camera = useThree((state) => state.camera);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);

  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera) || width === 0 || height === 0) return;
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * (width / height);
    const sin = Math.sin(CAMERA_PITCH);
    const cos = Math.cos(CAMERA_PITCH);
    // Distance needed to fit the near edge (the widest, lowest thing on screen) both ways.
    const nearPull = FRAME_HALF_DEPTH * cos;
    const fitWidth = FRAME_HALF_WIDTH / tanH + nearPull;
    const fitDepth = (FRAME_HALF_DEPTH * sin) / tanV + nearPull;
    const distance = Math.max(fitWidth, fitDepth);
    camera.position.set(0, distance * sin, LOOK_AT_Z + distance * cos);
    camera.lookAt(0, 0, LOOK_AT_Z);
    camera.updateProjectionMatrix();
  }, [camera, width, height]);

  return null;
}
