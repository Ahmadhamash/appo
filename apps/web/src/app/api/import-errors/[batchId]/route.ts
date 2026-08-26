import { csvCell } from "@jormall/domain/operations-intelligence";

import { operationsIntelligenceRepository, requireTenantAccess } from "../../../../server/identity";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/import-errors/[batchId]">,
) {
  const { batchId } = await context.params;
  const access = await requireTenantAccess("en");
  const encoder = new TextEncoder();
  let offset = 0;
  let header = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!header) {
          controller.enqueue(encoder.encode("\uFEFFrow,status,error_code,error_field,message\r\n"));
          header = true;
        }
        const rows = await operationsIntelligenceRepository.getImportErrors(
          access,
          batchId,
          offset,
        );
        if (rows.length) {
          const lines = rows.map((row) =>
            [
              String(row.rowNumber),
              row.status,
              row.errorCode ?? "",
              row.errorField ?? "",
              row.safeMessage ?? "",
            ]
              .map(csvCell)
              .join(","),
          );
          controller.enqueue(encoder.encode(`${lines.join("\r\n")}\r\n`));
          offset += rows.length;
        }
        if (rows.length < 250) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="import-errors-${batchId}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
