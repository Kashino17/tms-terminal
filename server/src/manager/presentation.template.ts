/**
 * Presentation HTML Template
 *
 * Builds a self-contained HTML presentation document with:
 * - Chart.js 4, Mermaid 11, Highlight.js 11 (github-dark)
 * - Dark theme CSS matching the app (#0F172A bg, #1B2336 surface, #3B82F6 primary)
 * - Touch swipe + keyboard navigation
 * - ReactNativeWebView message bridge for slide tracking
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPresentationHTML(title: string, slides: string[]): string {
  const slideMarkup = slides
    .map(
      (html, i) =>
        `<div class="slide${i === 0 ? ' active' : ''}" data-index="${i}">${html}</div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${escapeHtml(title)}</title>

<!-- Chart.js 4 -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<!-- Mermaid 11 -->
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
<!-- Highlight.js 11 -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"><\/script>

<style>
/* ── Reset ─────────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0F172A;color:#F8FAFC}

/* ── Slide Container ───────────────────────────────────── */
.slide{position:absolute;inset:0;padding:12px 20px 60px;display:none;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;opacity:0;transform:translateX(40px);transition:opacity .35s ease,transform .35s ease}
.slide.active{display:flex;opacity:1;transform:translateX(0)}
.slide.exit-left{display:flex;opacity:0;transform:translateX(-40px)}

/* ── Typography ────────────────────────────────────────── */
h1{font-size:28px;font-weight:800;line-height:1.2;margin-bottom:16px;color:#F8FAFC}
h2{font-size:22px;font-weight:700;line-height:1.3;margin-bottom:12px;color:#F8FAFC}
h3{font-size:17px;font-weight:600;line-height:1.4;margin-bottom:8px;color:#E2E8F0}
p{font-size:15px;line-height:1.65;margin-bottom:10px;color:#CBD5E1}
ul,ol{padding-left:20px;margin-bottom:10px}
li{font-size:14px;line-height:1.6;margin-bottom:6px;color:#CBD5E1}
li::marker{color:#3B82F6}
strong{color:#F8FAFC;font-weight:700}
em{color:#94A3B8}
a{color:#3B82F6;text-decoration:none}

/* ── Code Blocks ───────────────────────────────────────── */
code{font-family:'SF Mono',Menlo,monospace;font-size:13px;background:#1E293B;padding:2px 6px;border-radius:4px;color:#06B6D4}
pre{background:#1E293B;border-radius:10px;padding:16px;margin-bottom:12px;overflow-x:auto}
pre code{background:none;padding:0;font-size:12px}

/* ── Grid Layouts ──────────────────────────────────────── */
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
@media(max-width:400px){.grid-2{grid-template-columns:1fr}.grid-3{grid-template-columns:1fr 1fr}}
.flex-row{display:flex;flex-direction:row;align-items:stretch;gap:12px}
.flex-col{display:flex;flex-direction:column;gap:8px}

/* ── Cards ─────────────────────────────────────────────── */
.card{background:#1B2336;border:1px solid #334155;border-radius:12px;padding:16px;margin-bottom:10px}
.card-sm{background:#1B2336;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:8px}

/* ── Gradient Backgrounds ──────────────────────────────── */
.gradient-blue{background:linear-gradient(135deg,#1E3A5F 0%,#1B2336 100%)}
.gradient-purple{background:linear-gradient(135deg,#312E81 0%,#1B2336 100%)}
.gradient-green{background:linear-gradient(135deg,#064E3B 0%,#1B2336 100%)}
.gradient-orange{background:linear-gradient(135deg,#7C2D12 0%,#1B2336 100%)}
.gradient-red{background:linear-gradient(135deg,#7F1D1D 0%,#1B2336 100%)}
.gradient-cyan{background:linear-gradient(135deg,#164E63 0%,#1B2336 100%)}

/* ── Accent Colors ─────────────────────────────────────── */
.accent{color:#3B82F6}
.accent-green{color:#22C55E}
.accent-red{color:#EF4444}
.accent-amber{color:#F59E0B}
.accent-cyan{color:#06B6D4}
.accent-purple{color:#A78BFA}

/* ── Badges ────────────────────────────────────────────── */
.badge{display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px}
.badge-blue{background:rgba(59,130,246,.2);color:#60A5FA}
.badge-green{background:rgba(34,197,94,.2);color:#4ADE80}
.badge-red{background:rgba(239,68,68,.2);color:#F87171}
.badge-amber{background:rgba(245,158,11,.2);color:#FBBF24}

/* ── Stat Numbers ──────────────────────────────────────── */
.stat{text-align:center;padding:8px 0}
.stat-value{font-size:36px;font-weight:800;line-height:1;color:#F8FAFC}
.stat-label{font-size:12px;color:#94A3B8;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}

/* ── Animations ────────────────────────────────────────── */
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideInLeft{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:translateX(0)}}
@keyframes scaleIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
.fade-in{animation:fadeIn .5s ease both}
.slide-up{animation:slideUp .5s ease both}
.slide-in-left{animation:slideInLeft .5s ease both}
.scale-in{animation:scaleIn .5s ease both}
.delay-1{animation-delay:.1s}
.delay-2{animation-delay:.2s}
.delay-3{animation-delay:.3s}
.delay-4{animation-delay:.4s}
.delay-5{animation-delay:.5s}

/* ── Utilities ─────────────────────────────────────────── */
.text-center{text-align:center}
.text-sm{font-size:13px}
.text-xs{font-size:11px}
.text-dim{color:#64748B}
.text-muted{color:#94A3B8}
.mt-1{margin-top:8px}.mt-2{margin-top:16px}.mt-3{margin-top:24px}
.mb-1{margin-bottom:8px}.mb-2{margin-bottom:16px}
.gap-1{gap:8px}.gap-2{gap:16px}
.divider{height:1px;background:#334155;margin:16px 0}
.w-full{width:100%}

/* ── Progress Bar ──────────────────────────────────────── */
#progress{position:fixed;top:0;left:0;height:3px;background:#3B82F6;transition:width .35s ease;z-index:100;border-radius:0 2px 2px 0}

/* ── Slide Counter ─────────────────────────────────────── */
#counter{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,.8);backdrop-filter:blur(8px);color:#94A3B8;font-size:12px;font-weight:600;padding:6px 16px;border-radius:20px;z-index:100;pointer-events:none}

/* ── Canvas for Charts ─────────────────────────────────── */
canvas{max-width:100%;max-height:200px;margin:8px 0}
</style>
</head>
<body>

${slideMarkup}

<div id="progress" style="width:${slides.length > 1 ? (100 / slides.length).toFixed(2) : '100'}%"></div>
<div id="counter">1 / ${slides.length}</div>

<script>
(function(){
  var slides = document.querySelectorAll('.slide');
  var total = slides.length;
  var current = 0;
  var progress = document.getElementById('progress');
  var counter = document.getElementById('counter');

  function goToSlide(idx) {
    if (idx < 0 || idx >= total || idx === current) return;
    var prev = current;
    slides[prev].classList.remove('active');
    slides[prev].classList.add('exit-left');
    current = idx;
    slides[current].classList.add('active');
    setTimeout(function(){ slides[prev].classList.remove('exit-left'); }, 400);
    progress.style.width = (((current + 1) / total) * 100) + '%';
    counter.textContent = (current + 1) + ' / ' + total;
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'slideChange', index: current, total: total }));
    } catch(e){}
  }

  window.goToSlide = goToSlide;

  // Touch swipe
  var startX = 0, startY = 0;
  document.addEventListener('touchstart', function(e){ startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', function(e){
    var dx = e.changedTouches[0].clientX - startX;
    var dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goToSlide(current + 1);
      else goToSlide(current - 1);
    }
  }, { passive: true });

  // Keyboard
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goToSlide(current + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goToSlide(current - 1); }
  });

  // ── Auto-init Charts ──────────────────────────────────
  function initCharts() {
    document.querySelectorAll('canvas[data-chart]').forEach(function(c) {
      try {
        var type = c.getAttribute('data-chart') || 'bar';
        var values = JSON.parse(c.getAttribute('data-values') || '[]');
        var labels = JSON.parse(c.getAttribute('data-labels') || '[]');
        var chartColors = JSON.parse(c.getAttribute('data-colors') || '["#3B82F6","#22C55E","#F59E0B","#EF4444","#A78BFA","#06B6D4"]');
        new Chart(c.getContext('2d'), {
          type: type,
          data: {
            labels: labels,
            datasets: [{
              data: values,
              backgroundColor: type === 'line' ? 'rgba(59,130,246,.2)' : chartColors,
              borderColor: type === 'line' ? '#3B82F6' : chartColors,
              borderWidth: type === 'line' ? 2 : 0,
              fill: type === 'line',
              tension: 0.4,
              borderRadius: type === 'bar' ? 6 : 0,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { display: false },
            },
            scales: type === 'pie' || type === 'doughnut' ? {} : {
              x: { ticks: { color: '#94A3B8', font: { size: 11 } }, grid: { color: 'rgba(51,65,85,.4)' } },
              y: { ticks: { color: '#94A3B8', font: { size: 11 } }, grid: { color: 'rgba(51,65,85,.4)' } },
            }
          }
        });
      } catch(e){ console.warn('Chart init error', e); }
    });
  }

  // ── Auto-init Mermaid ─────────────────────────────────
  function initMermaid() {
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({
        startOnLoad: true,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#1B2336',
          primaryTextColor: '#F8FAFC',
          primaryBorderColor: '#3B82F6',
          lineColor: '#3B82F6',
          secondaryColor: '#243044',
          tertiaryColor: '#0F172A',
          fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif',
        }
      });
    }
  }

  // ── Auto-init Highlight.js ────────────────────────────
  function initHighlight() {
    if (typeof hljs !== 'undefined') {
      hljs.highlightAll();
    }
  }

  // ── Ready ─────────────────────────────────────────────
  function onReady() {
    initCharts();
    initMermaid();
    initHighlight();
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready', total: total }));
    } catch(e){}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(onReady, 100);
  } else {
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(onReady, 100); });
  }
})();
<\/script>
</body>
</html>`;
}
