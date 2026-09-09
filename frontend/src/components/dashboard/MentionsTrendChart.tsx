import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ACCENT_COLOR, BORDER_COLOR, INK_MUTED_COLOR } from '../../styles/theme';
import styles from './MentionsTrendChart.module.css';

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

export function MentionsTrendChart({ data }: { data: { date: string; count: number }[] }) {
  if (data.length === 0) {
    return <p className={styles.empty}>Нет данных за выбранный период.</p>;
  }

  return (
    <div className={styles.wrapper}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT_COLOR} stopOpacity={0.25} />
              <stop offset="100%" stopColor={ACCENT_COLOR} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={BORDER_COLOR} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDay}
            tick={{ fontSize: 12, fill: INK_MUTED_COLOR }}
            axisLine={{ stroke: BORDER_COLOR }}
            tickLine={false}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: INK_MUTED_COLOR }} axisLine={false} tickLine={false} width={32} />
          <Tooltip
            formatter={(value: number) => [value, 'Упоминаний']}
            labelFormatter={(label: string) => formatDay(label)}
            contentStyle={{ background: '#ffffff', border: `1px solid ${BORDER_COLOR}`, borderRadius: 8, fontSize: 13 }}
          />
          <Area type="monotone" dataKey="count" stroke={ACCENT_COLOR} strokeWidth={2} fill="url(#trendFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
