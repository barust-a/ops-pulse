interface DataSummaryTableProps {
  readonly caption: string;
  readonly columns: readonly string[];
  /** One row per data point; the first cell must be unique, it keys the row. */
  readonly rows: readonly (readonly string[])[];
}

/** The chart's data as a plain table, the text alternative to the canvas. */
export function DataSummaryTable({ caption, columns, rows }: DataSummaryTableProps) {
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.join('|')}>
            {row.map((cell, index) => (
              <td key={`${String(index)}-${cell}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
