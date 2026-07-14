import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';

// Initialize mermaid with a theme that fits the dark Zinc UI.
// suppressErrorRendering: `code` streams in token-by-token (see the doc below),
// so most renders during a stream are expected parse failures. Without this,
// mermaid's default behavior on a parse error is to draw its own bomb-icon
// error diagram directly into document.body (bypassing React) and only THEN
// throw — so the throw skips its own cleanup and that diagram is permanently
// orphaned in the page, one per failed token. This flag makes it clean up and
// throw immediately instead, so nothing is ever drawn for a failed parse; the
// catch below still renders our own small in-place error text.
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: 'inherit',
  suppressErrorRendering: true,
});

interface MermaidRendererProps {
  code: string;
}

/**
 * A component that renders Mermaid diagrams with zoom, pan, and SVG export capabilities.
 *
 * `code` streams in token-by-token while the assistant is still generating
 * the message (see Markdown -> MdCode), so most renders during a stream see
 * truncated/invalid Mermaid source and are EXPECTED to fail — only the final,
 * complete chunk is guaranteed to parse. Errors must therefore be transient
 * (state, not a ref) so a later successful render clears them and repaints;
 * a ref-held error doesn't trigger a re-render, so the UI would otherwise get
 * stuck showing the last mid-stream parse failure even once the finished
 * diagram is valid.
 */
export function MermaidRenderer({ code }: MermaidRendererProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [svgContent, setSvgContent] = useState<string | null>(null);
  // Guards against an in-flight render for stale `code` overwriting the DOM
  // after a newer one has already started (renders are async and can resolve
  // out of order as tokens stream in).
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    const renderDiagram = async () => {
      try {
        const id = `mermaid-${Math.random().toString(36).substring(7)}`;
        const { svg } = await mermaid.render(id, code);
        if (tokenRef.current !== token) return; // superseded by a newer render
        setSvgContent(svg);
        setError(null);
      } catch (err) {
        if (tokenRef.current !== token) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setSvgContent(null);
      }
    };

    void renderDiagram();
  }, [code]);

  const exportSvg = () => {
    if (!svgContent) return;
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-4 flex flex-col items-center justify-center w-full overflow-hidden">
      {error && (
        <div className="rounded border border-red-900/50 bg-red-900/20 p-3 text-xs text-red-400">
          <p className="font-bold">Mermaid Error:</p>
          <p>{error}</p>
        </div >
      )}

      {!error && svgContent && (
        <div className="w-full h-full min-h-[200px] relative border border-zinc-800 rounded-lg bg-zinc-950/50 overflow-hidden">
          <TransformWrapper
            initialScale={1}
            minScale={0.2}
            maxScale={10}
          >
            {({ zoomIn, zoomOut, resetTransform }) => (
              <>
                {/* Floating Controls */}
                <div className="absolute bottom-2 right-2 z-10 flex gap-1">
                  <button
                    onClick={() => zoomIn()}
                    className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title="Zoom In"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                  </button>
                  <button
                    onClick={() => zoomOut()}
                    className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title="Zoom Out"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                  </button>
                  <button
                    onClick={() => resetTransform()}
                    className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title="Reset"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  </button>
                  <button
                    onClick={exportSvg}
                    className="p-1.5 rounded bg-blue-900/40 hover:bg-blue-800/60 text-blue-400 transition-colors border border-blue-800/50"
                    title="Export SVG"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </button>
                </div >

                <TransformComponent
                  wrapperStyle={{
                    width: '100%',
                    height: '100%',
                  }}
                >
                  <div
                    className="mermaid-svg-container flex justify-center min-h-[40px] p-4"
                    // Declarative, not imperative: this div only mounts once svgContent is
                    // truthy (see the conditional above). An effect that instead wrote into
                    // a ref *before* setSvgContent would race the mount - the ref is still
                    // null at that point, since this div doesn't exist yet - which was
                    // exactly the bug that made previously-working diagrams render blank.
                    // dangerouslySetInnerHTML paints in the same render pass as the mount.
                    dangerouslySetInnerHTML={svgContent ? { __html: svgContent } : undefined}
                  />
                </TransformComponent>
              </>
            )}
          </TransformWrapper>
        </div >
      )}
    </div >
  );
}
