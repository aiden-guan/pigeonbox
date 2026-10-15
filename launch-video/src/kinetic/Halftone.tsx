import React, { useLayoutEffect, useRef } from "react";

/**
 * The brand's halftone dot matrix (pigeonboxsite/halftone.js), as a deterministic,
 * frame-driven canvas: every frame redraws its dots from scratch.
 */

export type Dot = { x: number; y: number; r: number; c: string; a?: number };

/** A canvas redrawn on every frame from `draw`. */
export const DotCanvas: React.FC<{ draw: (ctx: CanvasRenderingContext2D) => void; deps: unknown[]; style?: React.CSSProperties }> = ({
  draw,
  deps,
  style,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    draw(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <canvas ref={ref} width={1920} height={1080} style={{ position: "absolute", inset: 0, width: 1920, height: 1080, ...style }} />;
};

export const fillDot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  if (r <= 0.15) return;
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
};
