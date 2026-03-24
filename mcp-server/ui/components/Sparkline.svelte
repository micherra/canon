<script lang="ts">
  interface Props {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
    label?: string;
  }

  let { values, width = 80, height = 24, color = "#4A90D9", label = "" }: Props = $props();

  let points = $derived.by(() => {
    if (values.length < 2) return "";
    const max = Math.max(...values, 0.01);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;
    return values
      .map((v, i) => {
        const x = pad + (i / (values.length - 1)) * w;
        const y = pad + h - ((v - min) / range) * h;
        return `${x},${y}`;
      })
      .join(" ");
  });

  let lastValue = $derived(values.length > 0 ? values[values.length - 1] : null);
</script>

{#if values.length >= 2}
  <div class="sparkline-container" title={label}>
    <svg {width} {height} viewBox="0 0 {width} {height}">
      <polyline
        fill="none"
        stroke={color}
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        points={points}
      />
    </svg>
    {#if lastValue !== null}
      <span class="sparkline-value" style="color:{color}">{Math.round(lastValue * 100)}%</span>
    {/if}
  </div>
{/if}

<style>
  .sparkline-container {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sparkline-value {
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
