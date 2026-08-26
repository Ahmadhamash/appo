const widgetStyles = `
:host{--jormall-primary:#125e46;--jormall-accent:#d7f265;position:fixed;z-index:2147483000;inset-block-end:1rem;inset-inline-end:1rem;font-family:Inter,"Noto Sans Arabic",system-ui,sans-serif;color:#17221c;pointer-events:none}
*{box-sizing:border-box}.launcher,.send,.verify-button{border:0;border-radius:999px;background:var(--jormall-primary);color:#fff;font:inherit;font-weight:750;cursor:pointer}.launcher{min-height:3rem;padding:.75rem 1.1rem;box-shadow:0 12px 36px rgb(0 0 0 / 22%)}
.launcher,.panel{pointer-events:auto}
.launcher:focus-visible,.send:focus-visible,.close:focus-visible,.message:focus-visible,.verify-input:focus-visible,.verify-button:focus-visible{outline:3px solid var(--jormall-accent);outline-offset:2px}
.panel{display:grid;width:min(24rem,calc(100vw - 2rem));height:min(38rem,calc(100vh - 6rem));margin-block-end:.75rem;border:1px solid #dce2da;border-radius:1.25rem;background:#fff;box-shadow:0 22px 70px rgb(0 0 0 / 24%);overflow:hidden;grid-template-rows:auto 1fr auto auto}
.panel[hidden]{display:none}.header{display:flex;align-items:center;justify-content:space-between;padding:1rem;background:var(--jormall-primary);color:#fff}.close{width:2.5rem;height:2.5rem;border:0;border-radius:.7rem;background:rgb(255 255 255 / 16%);color:#fff;font-size:1.5rem;cursor:pointer}
.log{display:flex;flex-direction:column;gap:.65rem;overflow:auto;padding:1rem;background:#f5f6f1}.bubble{width:fit-content;max-width:88%;margin:0;padding:.7rem .85rem;border-radius:1rem;line-height:1.45;white-space:pre-wrap}.customer{align-self:flex-end;background:var(--jormall-primary);color:#fff;border-end-end-radius:.25rem}.assistant{align-self:flex-start;background:#fff;border:1px solid #dce2da;border-end-start-radius:.25rem}
.composer,.verify-form{display:flex;gap:.5rem;padding:.75rem;border-block-start:1px solid #dce2da}.message,.verify-input{width:100%;min-height:2.75rem;border:1px solid #aeb9b0;border-radius:.75rem;padding:.65rem .75rem;font:inherit}.send,.verify-button{padding:.65rem .9rem}.send:disabled,.verify-button:disabled{opacity:.55;cursor:wait}
.verification{padding:.6rem .75rem;border-block-start:1px solid #dce2da}.verify-summary{color:var(--jormall-primary);font-weight:700;cursor:pointer}.verify-form{display:grid;padding:.75rem 0 0;border:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:36rem){:host{inset:0}.launcher{position:absolute;inset-block-end:1rem;inset-inline-end:1rem}.panel{width:100vw;height:100dvh;margin:0;border:0;border-radius:0}}
@media(prefers-reduced-motion:no-preference){.panel{animation:jormall-in .16s ease-out}@keyframes jormall-in{from{opacity:0;transform:translateY(.5rem)}}}
`;

export function GET(): Response {
  return new Response(widgetStyles, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
