/**
 * Touch screens (phones, tablets) get a borderless table: the wooden rail and tabletop are not
 * drawn, the felt runs past the screen edges, and the camera frames the felt alone.
 * Mouse-driven screens show the whole wooden tray.
 */
export const IS_TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
