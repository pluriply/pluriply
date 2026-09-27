// 허브의 활동 응답(hook.poll·agent.wait)을 모델이 읽을 문구로 만든다(Plan 4c §5, Plan 5a §7).
// 순수 함수. 공개 코드라 허브를 import 하지 않는다.
const MAX_TEXT = 2000;
const MORE_LINE = (n) => `(+${n} more: run list_tasks)`;

/**
 * @param {{tool: string, cwd: string, channelCode: string, incoming?: object[], results?: object[], stalled?: object[], more?: number}} r
 * @returns {string}
 */
export function formatActivity(r) {
  const head = `pluriply: new activity on channel ${r.channelCode} for ${r.tool} (cwd ${r.cwd}). Handle it before finishing.`;
  const inLines = (r.incoming ?? []).map(
    (t) => `- ${t.taskId} ${t.kind ?? "task"} from ${t.from}: "${t.summary}"`,
  );
  const resLines = (r.results ?? []).map(
    (t) => `- ${t.taskId} ${t.status} by ${t.to}: "${t.summary}"`,
  );
  const stallLines = (r.stalled ?? []).map(
    (t) => `- ${t.taskId} to ${t.to}: "${t.summary}" — ${t.hint}`,
  );
  let more = r.more ?? 0;
  const build = () => {
    const parts = [head];
    if (inLines.length)
      parts.push(
        "Incoming tasks (do the work, then submit_result — or submit_review for reviews; skip one another instance already claimed):",
        ...inLines,
      );
    if (resLines.length)
      parts.push(
        "Results of tasks you delegated (read them with get_task_result):",
        ...resLines,
      );
    if (stallLines.length)
      parts.push(
        "Waiting on others (no live session picked these up; see the hint):",
        ...stallLines,
      );
    if (more > 0) parts.push(MORE_LINE(more));
    return parts.join("\n");
  };
  let text = build();
  // 2,000자를 넘으면 대기 알림 → 결과 → 받은 태스크 순으로 뒤에서부터 덜어내고 more 를 늘린다
  while (
    text.length > MAX_TEXT &&
    inLines.length + resLines.length + stallLines.length > 0
  ) {
    if (stallLines.length) stallLines.pop();
    else if (resLines.length) resLines.pop();
    else inLines.pop();
    more++;
    text = build();
  }
  return text;
}
