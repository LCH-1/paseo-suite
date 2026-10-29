import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { TimelinePage } from "./session";

export const mono = Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "Consolas, monospace";

export const TimelineRow = memo(function TimelineRow({ entry, theme }: {
  entry: TimelinePage["entries"][number]; theme: PluginTheme;
}) {
  const [expanded, setExpanded] = useState(false);
  const item = entry.item;
  const color = theme.colors;
  const text = { color: color.foreground, fontFamily: mono, fontSize: 13, lineHeight: 21 };
  const muted = { ...text, color: color.foregroundMuted };
  if (item.type === "user_message") return <View style={{ padding: 12, backgroundColor: color.surface2,
    borderLeftWidth: 2, borderLeftColor: color.accent, marginTop: 16 }}>
    <Text selectable style={text}><Text style={{ color: color.accent }}>❯ </Text>{item.text}</Text>
  </View>;
  if (item.type === "assistant_message") return <Text selectable style={{ ...text, paddingVertical: 10 }}>{item.text}</Text>;
  if (item.type === "error" || item.type === "notification") return <Text selectable style={{ ...text,
    color: item.type === "error" || item.level === "error" ? color.statusDanger : color.statusWarning,
    paddingVertical: 5 }}>{item.message}</Text>;
  if (item.type === "todo") return <View style={{ gap: 3, paddingVertical: 8 }}>{item.items.map((task, index) =>
    <Text key={task.id ?? index} style={task.completed ? muted : text}>{task.completed ? "✓" : "○"} {task.text}</Text>)}</View>;
  if (item.type === "compaction") return <Text style={muted}>· {item.status === "loading" ? "대화 압축 중…" : "대화 압축 완료"}</Text>;
  const label = item.type === "tool_call" ? `${item.name}  ${item.status === "running" ? "실행 중" : item.status === "failed" ? "실패" : item.status === "canceled" ? "취소됨" : "완료"}`
    : item.type === "reasoning" ? "생각 과정" : `${item.pluginId} / ${item.kind}`;
  const content = item.type === "tool_call" ? JSON.stringify(item.detail, null, 2)
    : item.type === "reasoning" ? item.text : JSON.stringify(item.data, null, 2);
  return <View style={{ paddingVertical: 5 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 상세 ${expanded ? "접기" : "펼치기"}`}
      onPress={() => setExpanded((value) => !value)} style={{ paddingVertical: 5 }}>
      <Text style={{ ...muted, color: item.type === "tool_call" && item.status === "failed" ? color.statusDanger : color.foregroundMuted }}>
        {expanded ? "▾" : "▸"} {label}
      </Text>
    </Pressable>
    {expanded && <Text selectable style={{ ...muted, padding: 10, backgroundColor: color.surface1 }}>
      {content.slice(0, 16000)}{content.length > 16000 ? "\n… 상세 내용은 기본 세션 화면에서 확인하세요." : ""}
    </Text>}
  </View>;
});
