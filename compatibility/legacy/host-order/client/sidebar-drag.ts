import type { Controller } from "./controller";

const headerPrefix = "sidebar-host-header-";
const headerSelector = `[data-testid^="${headerPrefix}"]`;
const groupSelector = '[data-testid^="sidebar-host-group-"]';
const dropAttribute = "data-paseo-host-drop";

export function installSidebarHostDrag(controller: Controller, document: Document): () => void {
  const window = document.defaultView!;
  const decorated = new Map<
    HTMLElement,
    { draggable: string | null; title: string | null; cursor: string }
  >();
  let sourceId: string | null = null;
  let target: { group: HTMLElement; serverId: string; position: "before" | "after" } | null = null;
  let lastDraggedId: string | null = null;
  let suppressClickUntil = 0;
  const style = document.createElement("style");
  style.textContent = `
    [${dropAttribute}] { position: relative; }
    [${dropAttribute}]::after {
      content: ""; position: absolute; left: 0; right: 0; height: 2px;
      background: var(--paseo-host-drop-color); pointer-events: none; z-index: 1001;
    }
    [${dropAttribute}="before"]::after { top: 0; }
    [${dropAttribute}="after"]::after { bottom: 0; }
  `;
  document.head.append(style);

  function decorate(header: HTMLElement) {
    if (decorated.has(header)) return;
    decorated.set(header, {
      draggable: header.getAttribute("draggable"),
      title: header.getAttribute("title"),
      cursor: header.style.cursor,
    });
    header.draggable = true;
    header.title = "드래그하여 호스트 순서 변경";
    header.style.cursor = "grab";
  }

  function restoreHeader(header: HTMLElement) {
    const previous = decorated.get(header)!;
    if (previous.draggable === null) header.removeAttribute("draggable");
    else header.setAttribute("draggable", previous.draggable);
    if (previous.title === null) header.removeAttribute("title");
    else header.setAttribute("title", previous.title);
    header.style.cursor = previous.cursor;
    decorated.delete(header);
  }

  function scan(element: Element) {
    if (element.matches(headerSelector)) decorate(element as HTMLElement);
    element.querySelectorAll<HTMLElement>(headerSelector).forEach(decorate);
  }
  scan(document.documentElement);
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof window.Element) scan(node);
      }
    }
    for (const header of decorated.keys()) {
      if (!header.isConnected) restoreHeader(header);
    }
    if (
      sourceId &&
      ![...decorated.keys()].some(
        (header) =>
          header.isConnected && header.getAttribute("data-testid") === headerPrefix + sourceId,
      )
    )
      clearDrag();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function eventElement(event: Event): Element | null {
    return event.target instanceof window.Element ? event.target : null;
  }

  function clearTarget() {
    if (!target) return;
    target.group.removeAttribute(dropAttribute);
    target.group.style.removeProperty("--paseo-host-drop-color");
    target = null;
  }

  function clearDrag() {
    clearTarget();
    if (sourceId) suppressClickUntil = Date.now() + 200;
    sourceId = null;
  }

  function onDragStart(event: DragEvent) {
    const header = eventElement(event)?.closest<HTMLElement>(headerSelector);
    if (!header || !event.dataTransfer) return;
    const serverId = header.getAttribute("data-testid")!.slice(headerPrefix.length);
    if (!controller.getSnapshot().hosts.some((host) => host.serverId === serverId)) return;
    sourceId = serverId;
    lastDraggedId = serverId;
    suppressClickUntil = Number.POSITIVE_INFINITY;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-paseo-host-order", serverId);
    const row = header.parentElement!;
    const rect = row.getBoundingClientRect();
    event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top);
    event.stopPropagation();
  }

  function onDragOver(event: DragEvent) {
    if (!sourceId) return;
    const group = eventElement(event)?.closest<HTMLElement>(groupSelector);
    const header = group?.querySelector<HTMLElement>(headerSelector);
    if (!group || !header) {
      clearTarget();
      return;
    }
    const serverId = header.getAttribute("data-testid")!.slice(headerPrefix.length);
    if (serverId === sourceId) {
      clearTarget();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = header.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (target?.group === group && target.position === position) return;
    clearTarget();
    target = { group, serverId, position };
    group.setAttribute(dropAttribute, position);
    const label =
      header.nextElementSibling?.querySelector('[dir="auto"]') ??
      header.nextElementSibling ??
      header;
    group.style.setProperty("--paseo-host-drop-color", window.getComputedStyle(label).color);
  }

  function onDrop(event: DragEvent) {
    if (!sourceId) return;
    const group = eventElement(event)?.closest(groupSelector);
    if (target && group === target.group) {
      event.preventDefault();
      event.stopPropagation();
      controller.moveTo(sourceId, target.serverId, target.position);
    }
    clearDrag();
  }

  function onDragEnd() {
    if (!sourceId) return;
    clearDrag();
  }

  function onDragLeave(event: DragEvent) {
    if (event.relatedTarget === null) clearTarget();
  }

  function onClick(event: MouseEvent) {
    const header = eventElement(event)?.closest(headerSelector);
    if (
      Date.now() <= suppressClickUntil &&
      header?.getAttribute("data-testid") === headerPrefix + lastDraggedId
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragend", onDragEnd, true);
  document.addEventListener("dragleave", onDragLeave, true);
  document.addEventListener("click", onClick, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("dragstart", onDragStart, true);
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("dragend", onDragEnd, true);
    document.removeEventListener("dragleave", onDragLeave, true);
    document.removeEventListener("click", onClick, true);
    clearDrag();
    for (const header of decorated.keys()) restoreHeader(header);
    style.remove();
  };
}
