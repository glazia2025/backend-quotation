const crypto = require("crypto");
const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

const MAX_IMAGE_BYTES = Number(process.env.QUOTATION_IMAGE_MAX_BYTES || 20 * 1024 * 1024);
const UPLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.QUOTATION_IMAGE_UPLOAD_CONCURRENCY || 8)
);

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const extensionByMimeType = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

const quotationImagePrefix = (quotationId) => `quotations/${quotationId}/`;

const buildPublicUrl = (key) => {
  const baseUrl = String(process.env.AWS_S3_BASE_URL || "").replace(/\/$/, "");
  if (baseUrl) return `${baseUrl}/${key}`;

  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
};

const publicUrlToKey = (value) => {
  const url = String(value || "").trim();
  if (!url) return null;

  const configuredBase = String(process.env.AWS_S3_BASE_URL || "").replace(/\/$/, "");
  const defaultBase = process.env.AWS_S3_BUCKET && process.env.AWS_REGION
    ? `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`
    : "";
  const base = [configuredBase, defaultBase].find(
    (candidate) => candidate && url.startsWith(`${candidate}/`)
  );
  return base ? decodeURIComponent(url.slice(base.length + 1)) : null;
};

const collectQuotationImageKeys = ({ items = [], globalConfig = {} } = {}) => {
  const values = [globalConfig?.logo];
  items.forEach((item) => {
    values.push(item?.refImage);
    (Array.isArray(item?.subItems) ? item.subItems : []).forEach((subItem) => {
      values.push(subItem?.refImage);
    });
  });
  return values.map(publicUrlToKey).filter(Boolean);
};

const parseImage = (value) => {
  const source = String(value || "").trim();
  if (
    !source ||
    source.startsWith("/") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^data:/i.test(source))
  ) {
    return null;
  }

  const dataUrlMatch = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/is);
  const contentType = dataUrlMatch?.[1]?.toLowerCase() || "image/png";
  const encoded = dataUrlMatch?.[2] || source;
  const extension =
    extensionByMimeType[contentType] ||
    contentType
      .slice("image/".length)
      .replace("+xml", "")
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 10) ||
    "img";

  const body = Buffer.from(encoded.replace(/\s/g, ""), "base64");
  if (!body.length) {
    const error = new Error("Quotation image is empty or invalid");
    error.statusCode = 400;
    throw error;
  }
  if (body.length > MAX_IMAGE_BYTES) {
    const error = new Error(
      `Quotation image exceeds ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
    );
    error.statusCode = 413;
    throw error;
  }

  return { body, contentType, extension };
};

const assertConfigured = () => {
  if (!process.env.AWS_S3_BUCKET || !process.env.AWS_REGION) {
    const error = new Error("S3 is not configured for quotation images");
    error.statusCode = 500;
    throw error;
  }
};

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => run())
  );
  return results;
}

const uploadImage = async (quotationId, value, uploadedKeys) => {
  const parsed = parseImage(value);
  if (!parsed) return value || "";

  assertConfigured();
  const key = `${quotationImagePrefix(quotationId)}${crypto.randomUUID()}.${parsed.extension}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: parsed.body,
      ContentType: parsed.contentType,
      CacheControl: "public, max-age=31536000, immutable",
      ACL: "public-read",
    })
  );
  uploadedKeys.push(key);
  return buildPublicUrl(key);
};

async function uploadQuotationImages({ quotationId, items = [], globalConfig = {} }) {
  const uploadedKeys = [];
  const tasks = [];

  items.forEach((item, itemIndex) => {
    tasks.push({ type: "item", itemIndex, value: item?.refImage });
    (Array.isArray(item?.subItems) ? item.subItems : []).forEach(
      (subItem, subItemIndex) => {
        tasks.push({
          type: "subItem",
          itemIndex,
          subItemIndex,
          value: subItem?.refImage,
        });
      }
    );
  });
  tasks.push({ type: "logo", value: globalConfig?.logo });

  let uploadedValues;
  try {
    uploadedValues = await mapWithConcurrency(
      tasks,
      UPLOAD_CONCURRENCY,
      (task) => uploadImage(quotationId, task.value, uploadedKeys)
    );
  } catch (error) {
    await deleteS3Keys(uploadedKeys).catch(() => {});
    throw error;
  }

  const nextItems = items.map((item) => ({
    ...item,
    subItems: Array.isArray(item?.subItems)
      ? item.subItems.map((subItem) => ({ ...subItem }))
      : [],
  }));
  const nextGlobalConfig = { ...globalConfig };

  tasks.forEach((task, index) => {
    const url = uploadedValues[index];
    if (task.type === "logo") {
      nextGlobalConfig.logo = url;
    } else if (task.type === "subItem") {
      nextItems[task.itemIndex].subItems[task.subItemIndex].refImage = url;
    } else {
      nextItems[task.itemIndex].refImage = url;
    }
  });

  return { items: nextItems, globalConfig: nextGlobalConfig, uploadedKeys };
}

async function deleteS3Keys(keys = []) {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (!uniqueKeys.length || !process.env.AWS_S3_BUCKET) return;

  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Delete: {
          Objects: uniqueKeys.slice(index, index + 1000).map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
}

async function deleteQuotationImages(quotationId) {
  if (!process.env.AWS_S3_BUCKET) return;

  let continuationToken;
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.AWS_S3_BUCKET,
        Prefix: quotationImagePrefix(quotationId),
        ContinuationToken: continuationToken,
      })
    );
    await deleteS3Keys((response.Contents || []).map((object) => object.Key));
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

module.exports = {
  collectQuotationImageKeys,
  deleteQuotationImages,
  deleteS3Keys,
  uploadQuotationImages,
};
