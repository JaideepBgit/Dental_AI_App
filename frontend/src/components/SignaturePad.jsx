import { forwardRef, useImperativeHandle, useRef, useEffect, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';

const CANVAS_HEIGHT = 140;

const SignaturePad = forwardRef((props, ref) => {
  const sigCanvas = useRef(null);
  const wrapperRef = useRef(null);
  const [width, setWidth] = useState(0);

  // The canvas only mounts once the wrapper has a measured width, so callers
  // can reach these before sigCanvas exists (e.g. clearing on case switch).
  // Treat "not mounted" as "empty" rather than throwing.
  useImperativeHandle(ref, () => ({
    clear: () => sigCanvas.current?.clear(),
    isEmpty: () => (sigCanvas.current ? sigCanvas.current.isEmpty() : true),
    // getCanvas, not getTrimmedCanvas: the latter routes through `trim-canvas`,
    // a CommonJS-only package Vite cannot resolve to a callable default export,
    // so it throws the moment a signature is submitted. Whitespace cropping is
    // cosmetic and the referral PDF scales the image anyway.
    toDataURL: () =>
      sigCanvas.current?.getCanvas().toDataURL('image/png') ?? null,
  }));

  // Canvas needs explicit pixel dimensions; a CSS-stretched canvas distorts stroke coordinates.
  useEffect(() => {
    const el = wrapperRef.current;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%', height: CANVAS_HEIGHT, lineHeight: 0, touchAction: 'none',
      }}
    >
      {width > 0 && (
        <SignatureCanvas
          ref={sigCanvas}
          penColor="#2457d6"
          canvasProps={{
            width,
            height: CANVAS_HEIGHT,
            style: {
              cursor: 'crosshair',
              display: 'block',
              // Without this a finger drag is claimed by the scroller -- on a
              // tablet the doctor pans the sheet instead of signing, which is
              // the one action on this screen that cannot be worked around.
              touchAction: 'none',
            },
          }}
        />
      )}
    </div>
  );
});

export default SignaturePad;
