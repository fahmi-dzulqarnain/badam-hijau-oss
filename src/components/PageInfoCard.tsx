import { dateFormat } from "@/lib/format";

export function PageInfoCard({
  ownerName,
  reviewedAt,
  docType,
  status,
  versionCount,
}: {
  ownerName: string | null;
  reviewedAt: Date | null;
  docType: string;
  status: string;
  versionCount: number;
}) {
  return (
    <>
      <div className="railhead">Page info</div>
      <div className="card">
        <dl>
          <dt>Owner</dt>
          <dd>{ownerName ?? "Unassigned"}</dd>
          <dt>Last reviewed</dt>
          <dd>{reviewedAt ? dateFormat.format(reviewedAt) : "Never"}</dd>
          <dt>Type</dt>
          <dd>{docType}</dd>
          <dt>Lifecycle</dt>
          <dd>{status}</dd>
          <dt>Versions</dt>
          <dd>{versionCount}</dd>
        </dl>
      </div>
    </>
  );
}
