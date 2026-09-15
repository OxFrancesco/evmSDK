const tiles = document.querySelectorAll('.bento');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      if (!motion.matches) entry.target.classList.add('arriving');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  tiles.forEach((tile) => {
    observer.observe(tile);
  });
}

const hoverPointer = matchMedia('(hover: hover) and (pointer: fine)');
for (const trigger of document.querySelectorAll('.capability-trigger')) {
  const popup = document.getElementById(trigger.getAttribute('popovertarget'));
  const card = trigger.closest('.bento');
  const title = trigger.closest('.tile-copy').querySelector('h3');
  title.id = `${popup.id}-title`;
  popup.setAttribute('aria-labelledby', title.id);
  trigger.setAttribute('aria-controls', popup.id);
  trigger.setAttribute('aria-label', `${title.textContent} capabilities`);
  let closeTimer, pinned = false;
  const position = () => {
    const anchor = card.getBoundingClientRect();
    const width = popup.offsetWidth, height = popup.offsetHeight;
    const gap = 6, edge = 16;
    const below = anchor.bottom + gap;
    const top = below + height <= innerHeight - edge ? below : anchor.top - height - gap;
    popup.style.left = `${Math.max(edge, Math.min(anchor.left, innerWidth - width - edge))}px`;
    popup.style.top = `${Math.max(edge, Math.min(top, innerHeight - height - edge))}px`;
  };
  const show = () => {
    clearTimeout(closeTimer);
    if (!popup.matches(':popover-open')) popup.showPopover();
    position();
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!pinned && !card.matches(':hover') && !popup.matches(':hover') && !popup.contains(document.activeElement)) popup.hidePopover();
    }, 180);
  };
  card.addEventListener('pointerenter', (event) => {
    if (hoverPointer.matches && event.pointerType === 'mouse') show();
  });
  card.addEventListener('pointerleave', scheduleClose);
  popup.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  popup.addEventListener('pointerleave', scheduleClose);
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    if (pinned && popup.matches(':popover-open')) popup.hidePopover();
    else { pinned = true; show(); }
  });
  popup.addEventListener('toggle', () => {
    const open = popup.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(open));
    if (!open) { pinned = false; clearTimeout(closeTimer); }
  });
  popup.addEventListener('focusout', () => {
    if (!pinned) scheduleClose();
  });
  window.addEventListener('resize', () => { if (popup.matches(':popover-open')) position(); });
  window.addEventListener('scroll', () => { if (popup.matches(':popover-open')) position(); }, { passive: true });
}
