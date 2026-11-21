import { useEffect, useLayoutEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import {
  BackSide,
  BoxGeometry,
  Color,
  type DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
} from "three";
import { RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

/**
 * A tiny procedural "studio" rendered once into a prefiltered environment map:
 * a dim room plus a few emissive panels. Gives the dice and rail soft, believable
 * reflections with zero network requests and no image assets.
 */
function buildStudio(): Scene {
  const studio = new Scene();
  const geometries = { room: new BoxGeometry(40, 40, 40), panel: new PlaneGeometry(1, 1) };

  studio.add(new Mesh(geometries.room, new MeshBasicMaterial({ color: new Color(0.07, 0.065, 0.06), side: BackSide })));

  const panel = (
    color: string,
    intensity: number,
    position: [number, number, number],
    size: [number, number],
  ) => {
    const material = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), side: DoubleSide });
    const mesh = new Mesh(geometries.panel, material);
    mesh.position.set(...position);
    mesh.scale.set(size[0], size[1], 1);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  };

  panel("#fff4e2", 5, [2, 14, 3], [16, 12]); // big overhead softbox (matches the key light)
  panel("#ffd9a8", 3.5, [16, 5, 4], [6, 10]); // warm side strip
  panel("#a9c8ff", 2.5, [-15, 6, -6], [8, 8]); // cool fill / rim
  panel("#ffffff", 6, [-4, 7, 15], [10, 2.5]); // thin strip behind the camera for edge glints
  return studio;
}

function StudioEnvironment({ intensity = 1 }: { intensity?: number }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const studio = buildStudio();
    const target = pmrem.fromScene(studio, 0.035);
    const previous = scene.environment;
    scene.environment = target.texture;
    return () => {
      scene.environment = previous;
      target.dispose();
      pmrem.dispose();
      studio.traverse((object) => {
        if (object instanceof Mesh) (object.material as MeshBasicMaterial).dispose();
      });
      // The two geometries are shared across the studio's meshes.
      const disposed = new Set<unknown>();
      studio.traverse((object) => {
        if (object instanceof Mesh && !disposed.has(object.geometry)) {
          disposed.add(object.geometry);
          object.geometry.dispose();
        }
      });
    };
  }, [gl, scene]);

  useEffect(() => {
    scene.environmentIntensity = intensity;
  }, [scene, intensity]);

  return null;
}

/** Half-extent of the area the shadow map has to cover (tray + rail + a little slack). */
const SHADOW_EXTENT = Math.max(TRAY_WIDTH, TRAY_DEPTH) / 2 + RAIL_THICKNESS + 1.2;

/** Soft key light with shadows, a cool shadowless fill, and studio reflections. */
export function Lighting() {
  const key = useRef<DirectionalLight>(null);
  useLayoutEffect(() => {
    key.current?.shadow.camera.updateProjectionMatrix();
  }, []);

  return (
    <>
      <StudioEnvironment intensity={0.55} />
      <hemisphereLight args={["#fff1dc", "#0d1f16", 0.2]} />
      <directionalLight
        ref={key}
        castShadow
        position={[5, 9.5, 4]}
        intensity={2.9}
        color="#fff3e0"
        shadow-mapSize={[2048, 2048]}
        shadow-radius={3}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={2}
        shadow-camera-far={26}
      />
      <directionalLight position={[-6, 6, -3]} intensity={0.45} color="#bcd4ff" />
    </>
  );
}

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
