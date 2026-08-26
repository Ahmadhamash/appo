import { operationsIntelligenceRepository, requireTenantAccess } from "../../../../server/identity";

export async function GET(_request: Request, context: RouteContext<"/api/data-exports/[jobId]">) {
  const { jobId } = await context.params;
  const access = await requireTenantAccess("en");
  const first = await operationsIntelligenceRepository.getExportCsvPage(access, jobId, 0);
  const encoder = new TextEncoder();
  let offset = first.lines.length;
  let initial = true;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const page = initial
          ? first
          : await operationsIntelligenceRepository.getExportCsvPage(access, jobId, offset);
        initial = false;
        if (!headerSent) {
          controller.enqueue(encoder.encode(`\uFEFF${first.header}\r\n`));
          headerSent = true;
        }
        if (page.lines.length) {
          controller.enqueue(encoder.encode(`${page.lines.join("\r\n")}\r\n`));
          if (page !== first) offset += page.lines.length;
        }
        if (page.lines.length < 250) {
          await operationsIntelligenceRepository.recordExportDownload(access, jobId);
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="jormall-${jobId}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
