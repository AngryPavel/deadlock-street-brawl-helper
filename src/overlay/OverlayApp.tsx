import { useEffect, useRef, useState } from 'react';
import {
  drawReads,
  gradesFromAdvice,
  overlayHasContent,
  scoresFromAdvice,
  type DrawnRect,
  type OverlayState,
} from '../brawl/draw';
import { ScoreTip } from '../components/ScoreTip';
import { AbilityPanel } from '../components/AbilityPanel';
import { log } from '../log';

declare global {
  interface Window {
    __overlayDrawn?: DrawnRect[];
    __overlayAdvice?: OverlayState['advice'];
  }
}

/** Renders in the transparent, click-through overlay window: a plate above every offered card (and an outline on the
 *  best one) on the canvas, a score breakdown tooltip while the cursor is over a plate (the window forwards mouse
 *  moves but never takes clicks or focus), and the RE-ROLL banner. It draws nothing unless the item draft screen is on
 *  the frame or the ability panel (the standard point allocation for the round, ~15 s after the draft closes) is up. */
export default function OverlayApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OverlayState | null>(null);
  const [panelState, setPanelState] = useState<OverlayState | null>(null);
  const drawnRef = useRef<DrawnRect[]>([]);
  const hoverRef = useRef<number | null>(null);
  const [hover, setHover] = useState<{ itemId: number; x: number; y: number; flip: boolean } | null>(null);

  const draw = (state: OverlayState) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!overlayHasContent(state) || !state.frameW || !state.frameH) {
      drawnRef.current = [];
      if (window.brawlAPI?.isE2E) {
        window.__overlayDrawn = [];
        window.__overlayAdvice = null;
      }
      return;
    }
    const sx = c.width / state.frameW,
      sy = c.height / state.frameH;
    const drawn: DrawnRect[] = [];
    if (state.draft)
      drawn.push(
        ...drawReads(
          ctx,
          state.reads,
          state.bestId,
          sx,
          sy,
          state.frameW,
          state.frameH,
          state.reroll,
          scoresFromAdvice(state.advice),
          state.rerollRect ?? null,
          gradesFromAdvice(state.advice),
        ),
      );
    // e2e-only: expose exactly what was stroked (frame px) so the harness can verify boxes without
    // re-deriving them from reads (PLAN.md item 3's boxes-<frame> check).
    drawnRef.current = drawn;
    if (window.brawlAPI?.isE2E) {
      window.__overlayDrawn = drawn;
      window.__overlayAdvice = state.draft ? state.advice : null; // what the harness reads in place of the old panel
    }
  };

  /** Hover: which plate (if any) is under the cursor. Does nothing unless a draft is on screen. */
  const onMove = (ev: MouseEvent) => {
    const st = stateRef.current;
    if (!st?.draft) return;
    const c = canvasRef.current;
    if (!c || !st.frameW) return;
    const sx = c.width / st.frameW,
      sy = c.height / st.frameH;
    const hit = drawnRef.current.find(
      (d) =>
        d.plate &&
        d.itemId !== null &&
        ev.clientX >= d.plate.x0 * sx &&
        ev.clientX <= d.plate.x1 * sx &&
        ev.clientY >= d.plate.y0 * sy &&
        ev.clientY <= d.plate.y1 * sy,
    );
    if (!hit || !hit.plate) {
      if (hoverRef.current !== null) {
        hoverRef.current = null;
        setHover(null);
      }
      return;
    }
    if (hoverRef.current === hit.itemId) return;
    hoverRef.current = hit.itemId;
    const flip = hit.plate.x1 * sx + 260 > window.innerWidth;
    setHover({
      itemId: hit.itemId!,
      x: flip ? hit.plate.x0 * sx - 8 : hit.plate.x1 * sx + 8,
      y: hit.plate.y0 * sy,
      flip,
    });
  };
  const clearHover = () => {
    if (hoverRef.current === null) return;
    hoverRef.current = null;
    setHover(null);
  };

  useEffect(() => {
    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      if (stateRef.current) draw(stateRef.current);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', clearHover);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', clearHover);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers only read refs
  }, []);

  useEffect(() => {
    const api = window.brawlAPI;
    if (!api) {
      log('overlay', 'warn', 'brawlAPI missing: not running under Electron');
      return;
    }
    return api.onOverlayState((state) => {
      stateRef.current = state;
      if (!state.draft) clearHover();
      setPanelState(state);
      draw(state);
    });
  }, []);

  const advice = panelState?.draft ? panelState.advice : null;
  const abilityPanel = panelState && !panelState.draft ? panelState.panel : null;
  const hovered = hover && advice ? advice.ranked.find((r) => r.itemId === hover.itemId) : null;

  return (
    <>
      <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }} />
      {advice?.reroll && (
        <div className="overlay-panel">
          <div className="overlay-panel-reroll">
            RE-ROLL · {advice.reroll.expectedBest.toFixed(2)} vs {advice.reroll.currentBest.toFixed(2)}
          </div>
        </div>
      )}
      {hover && hovered && (
        <ScoreTip
          card={hovered}
          style={{ left: hover.x, top: hover.y, transform: hover.flip ? 'translateX(-100%)' : undefined }}
        />
      )}
      {abilityPanel && <AbilityPanel panel={abilityPanel} className="overlay-ap" />}
    </>
  );
}
