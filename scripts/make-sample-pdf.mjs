// Generates two small demo PDFs so the RAG pipeline can be tested end to end.
// Run: npm run sample
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(root, "pdfs");
await mkdir(outDir, { recursive: true });

const documents = [
  {
    file: "orion-platform-guide.pdf",
    title: "Orion Analytics Platform — Deployment Guide",
    pages: [
      {
        heading: "1. Overview",
        paragraphs: [
          "Orion is the analytics platform maintained by the Data Systems group. Version 4.2 was released in March 2025 and is the current long-term-support release. It ingests event streams, builds materialised views, and exposes dashboards through a REST and GraphQL API.",
          "Orion can be deployed in three ways: Orion Cloud (fully managed), on-premises with Helm, or a hybrid setup where the control plane stays in Orion Cloud and query workers run inside the customer network. The hybrid option is recommended for regulated customers who must keep raw data on site.",
        ],
      },
      {
        heading: "2. Installation requirements",
        paragraphs: [
          "The minimum supported platform is Kubernetes 1.29 with at least 16 GB of RAM per query worker and 4 vCPU per ingest node. The metadata store requires PostgreSQL 16 or newer, with the pgcrypto extension enabled.",
          "Install the Helm chart from the orion-charts repository, then apply the values file for your environment. The default namespace is orion-system. After the release is installed, run `orionctl doctor` to validate connectivity to PostgreSQL, object storage and the licence service.",
        ],
      },
      {
        heading: "3. Security and encryption",
        paragraphs: [
          "All network traffic between Orion components uses mutual TLS 1.3. Data at rest is encrypted with AES-256-GCM. Customer-managed keys are supported through the KMS integration, and keys can be rotated without downtime.",
          "Authentication uses OIDC single sign-on with support for any compliant identity provider. Role-based access control is evaluated per dataset. Audit logs are immutable and retained for 400 days by default.",
        ],
      },
      {
        heading: "4. Plans and support",
        paragraphs: [
          "The Standard plan costs 499 USD per month and includes up to 25 named users, 30-day log retention and email support during business hours. The Enterprise plan costs 1,899 USD per month with unlimited named users, 400-day audit retention, a 99.95 percent uptime SLA and 24/7 support with a one-hour response target.",
          "Annual billing receives a 15 percent discount. Non-profit and academic organisations qualify for a further 20 percent discount on the Standard plan only.",
        ],
      },
      {
        heading: "5. Troubleshooting",
        paragraphs: [
          "Error code OR-5031 means the licence token has expired. Rotate the token with `orionctl licence rotate` and restart the ingest controller. Error OR-4102 indicates that the PostgreSQL connection pool is exhausted; raise max_connections or reduce the number of query workers.",
          "If dashboards show stale data, check the materialised view scheduler. A backlog greater than five minutes usually means the ingest queue is throttled by the object storage rate limit.",
        ],
      },
    ],
  },
  {
    file: "orion-security-whitepaper.pdf",
    title: "Orion Security Whitepaper",
    pages: [
      {
        heading: "Data protection",
        paragraphs: [
          "Orion protects customer data with AES-256-GCM encryption at rest and TLS 1.3 in transit. Encryption keys are stored in a hardware security module and rotated every 90 days by default. Customers on the Enterprise plan may supply their own keys through AWS KMS, Azure Key Vault or Google Cloud KMS.",
          "Backups are encrypted with the same keys and replicated to a second region. A restore test is performed monthly, and the results are recorded in the status page.",
        ],
      },
      {
        heading: "Compliance and assurance",
        paragraphs: [
          "Orion holds SOC 2 Type II certification and completes an independent penetration test every year. The most recent penetration test was completed in January 2026 with no critical findings. A summary report is available to customers under NDA.",
          "Customer data is deleted within 30 days of contract termination. Data residency can be pinned to the EU (Frankfurt) or the US (Virginia) region at provisioning time; changing the region afterwards requires a new tenant.",
        ],
      },
    ],
  },
];

for (const document of documents) {
  const filePath = path.join(outDir, document.file);
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    info: { Title: document.title, Author: "Orion Documentation Team" },
  });

  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  document.pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text(document.title);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#1a4d8f").text(page.heading);
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(11).fillColor("#222222");
    for (const paragraph of page.paragraphs) {
      doc.text(paragraph, { align: "left", lineGap: 2 });
      doc.moveDown(0.8);
    }
    doc.fontSize(9).fillColor("#888888").text(`Page ${index + 1} of ${document.pages.length}`, {
      align: "center",
    });
  });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  console.log(`Wrote ${path.relative(root, filePath)}`);
}

await writeFile(path.join(outDir, ".gitkeep"), "", "utf8").catch(() => undefined);
