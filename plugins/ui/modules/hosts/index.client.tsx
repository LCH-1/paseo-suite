import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { readAppBundle } from "../../client/bundle-modules";
import { acquireController, hostModulesMatch } from "./client/bridge";
import { HostOrderSettings } from "./client/settings";
import { installSidebarHostDrag } from "./client/sidebar-drag";
import { resolveModuleMap, type HostModuleMap } from "./client/resolve-modules";

export default function contribute(client: PluginClientContext) {
  let stopped = false;
  let stopContributions: (() => void) | undefined;
  const request = new AbortController();

  function start(ids?: HostModuleMap) {
    if (stopped) return;
    const current = acquireController(
      (controller) => installSidebarHostDrag(controller, document),
      ids,
    );
    const cleanups = [() => current.release()];
    const cleanup = () => {
      const failures = [];
      for (const remove of cleanups.splice(0).reverse()) {
        try { remove(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "호스트 순서 등록을 정리하지 못했습니다.");
    };
    function Settings(props: PluginSurfaceProps) {
      return <HostOrderSettings {...props} controller={current.controller} />;
    }
    try {
      cleanups.push(client.addSettingsScreen({
        id: "order",
        title: "호스트 순서",
        icon: "ListOrdered",
        Component: Settings,
      }));
      cleanups.push(client.addCommandCenterItem({
        id: "order",
        title: "호스트 순서 설정",
        icon: "ListOrdered",
        context: "global",
        keywords: ["host", "order", "호스트", "순서"],
        onSelect: ({ openSettings }) => openSettings("order"),
      }));
    } catch (error) {
      try { cleanup(); }
      catch (failure) { throw new AggregateError([error, failure], "호스트 순서 초기화와 정리가 실패했습니다."); }
      throw error;
    }
    if (stopped) cleanup();
    else stopContributions = cleanup;
  }

  if (typeof document === "undefined") start();
  else {
    void resolveModuleMap(
      Array.from(document.scripts, (script) => script.src),
      (url) => readAppBundle(url, request.signal),
      undefined,
      hostModulesMatch,
    )
      .catch((error: unknown) => {
        if (stopped) return;
        console.warn("[host-order] 호스트 순서 모듈을 확인하지 못했습니다.", error);
        return undefined;
      })
      .then((ids) => {
        if (stopped) return;
        try { start(ids); }
        catch (error) { console.warn("[host-order] 호스트 순서를 초기화하지 못했습니다.", error); }
      });
  }
  return () => {
    if (stopped) return;
    stopped = true;
    request.abort();
    stopContributions?.();
  };
}
