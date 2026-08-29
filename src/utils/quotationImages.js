const crypto = require("crypto");
const sharp = require("sharp");
const {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

const MAX_IMAGE_BYTES = Number(process.env.QUOTATION_IMAGE_MAX_BYTES || 20 * 1024 * 1024);
const UPLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.QUOTATION_IMAGE_UPLOAD_CONCURRENCY || 8)
);
const QUOTATION_S3_BUCKET =
  process.env.QUOTATION_S3_BUCKET || "quotation-img";
const PDF_IMAGE_MAX_DIMENSION = Math.max(
  320,
  Number(process.env.QUOTATION_PDF_IMAGE_MAX_DIMENSION || 1200)
);
const PDF_IMAGE_JPEG_QUALITY = Math.min(
  100,
  Math.max(40, Number(process.env.QUOTATION_PDF_IMAGE_JPEG_QUALITY || 78))
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
  const region = process.env.AWS_REGION;
  return `https://${QUOTATION_S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
};

const publicUrlToKey = (value) => {
  const url = String(value || "").trim();
  if (!url) return null;

  try {
    const key = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return key.startsWith("quotations/") ? key : null;
  } catch (_error) {
    return null;
  }
};

const normalizeQuotationImageUrl = (value) => {
  const key = publicUrlToKey(value);
  return key ? buildPublicUrl(key) : value;
};

const normalizeQuotationImageReferences = (quotation = {}) => ({
  ...quotation,
  globalConfig: quotation.globalConfig
    ? {
        ...quotation.globalConfig,
        logo: normalizeQuotationImageUrl(quotation.globalConfig.logo),
      }
    : quotation.globalConfig,
  items: Array.isArray(quotation.items)
    ? quotation.items.map((item) => ({
        ...item,
        refImage: normalizeQuotationImageUrl(item?.refImage),
        subItems: Array.isArray(item?.subItems)
          ? item.subItems.map((subItem) => ({
              ...subItem,
              refImage: normalizeQuotationImageUrl(subItem?.refImage),
            }))
          : item?.subItems,
      }))
    : quotation.items,
});

const isMissingS3ObjectError = (error) =>
  error?.name === "NoSuchKey" ||
  error?.Code === "NoSuchKey" ||
  error?.code === "NoSuchKey" ||
  error?.$metadata?.httpStatusCode === 404;

const sanitizePdfImageReference = (value) => {
  const source = String(value || "").trim();
  if (!source) return "";
  if (!/^data:/i.test(source)) return source;

  const match = source.match(
    /^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/\s]+={0,2})$/
  );
  if (!match) return "";

  const encoded = match[1].replace(/\s/g, "");
  if (!encoded || encoded.length % 4 !== 0) return "";
  return source;
};

const s3ImageToDataUrl = async (value, { optimizeForPdf = false } = {}) => {
  const key = publicUrlToKey(value);
  if (!key) return value || "";

  assertConfigured();
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: QUOTATION_S3_BUCKET,
      Key: key,
    })
  );
  let body = Buffer.from(await response.Body.transformToByteArray());
  if (!body.length) {
    throw new Error(`Quotation image ${key} is empty`);
  }
  let contentType = response.ContentType || "image/png";
  if (optimizeForPdf && contentType !== "image/svg+xml") {
    try {
      body = await sharp(body, { failOn: "none" })
        .rotate()
        .resize({
          width: PDF_IMAGE_MAX_DIMENSION,
          height: PDF_IMAGE_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: PDF_IMAGE_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      contentType = "image/jpeg";
    } catch (error) {
      console.warn("Unable to optimize quotation image for PDF; using original:", error.message);
    }
  }
  return `data:${contentType};base64,${body.toString("base64")}`;
};

async function inlineQuotationImages(quotation = {}) {
  const nextQuotation = {
    ...quotation,
    globalConfig: quotation.globalConfig
      ? { ...quotation.globalConfig }
      : quotation.globalConfig,
    items: Array.isArray(quotation.items)
      ? quotation.items.map((item) => ({
          ...item,
          subItems: Array.isArray(item?.subItems)
            ? item.subItems.map((subItem) => ({ ...subItem }))
            : item?.subItems,
        }))
      : quotation.items,
  };

  const tasks = [];
  if (nextQuotation.globalConfig?.logo) {
    nextQuotation.globalConfig.logo = sanitizePdfImageReference(
      nextQuotation.globalConfig.logo
    );
  }
  if (nextQuotation.globalConfig?.logo) {
    tasks.push(
      s3ImageToDataUrl(nextQuotation.globalConfig.logo)
        .then((value) => {
          nextQuotation.globalConfig.logo = value;
        })
        .catch((error) => {
          if (!isMissingS3ObjectError(error)) throw error;
          console.warn("Quotation logo is missing from S3; rendering PDF without it");
          nextQuotation.globalConfig.logo = "";
        })
    );
  }
  (nextQuotation.items || []).forEach((item) => {
    item.refImage = sanitizePdfImageReference(item?.refImage);
    if (item?.refImage) {
      tasks.push(
        s3ImageToDataUrl(item.refImage, { optimizeForPdf: true })
          .then((value) => {
            item.refImage = value;
          })
          .catch((error) => {
            if (!isMissingS3ObjectError(error)) throw error;
            console.warn("Quotation item image is missing from S3; rendering PDF without it");
            item.refImage = "";
          })
      );
    }
    (item?.subItems || []).forEach((subItem) => {
      subItem.refImage = sanitizePdfImageReference(subItem?.refImage);
      if (!subItem?.refImage) return;
      tasks.push(
        s3ImageToDataUrl(subItem.refImage, { optimizeForPdf: true })
          .then((value) => {
            subItem.refImage = value;
          })
          .catch((error) => {
            if (!isMissingS3ObjectError(error)) throw error;
            console.warn("Quotation sub-item image is missing from S3; rendering PDF without it");
            subItem.refImage = "";
          })
      );
    });
  });

  await Promise.all(tasks);
  return nextQuotation;
}

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
  if (!QUOTATION_S3_BUCKET || !process.env.AWS_REGION) {
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
  if (!parsed) {
    const sourceKey = publicUrlToKey(value);
    const destinationPrefix = quotationImagePrefix(quotationId);
    if (!sourceKey || sourceKey.startsWith(destinationPrefix)) return value || "";

    assertConfigured();
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: QUOTATION_S3_BUCKET,
        Key: sourceKey,
      })
    );
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (!body.length) throw new Error(`Quotation image ${sourceKey} is empty`);
    if (body.length > MAX_IMAGE_BYTES) {
      const error = new Error(
        `Quotation image exceeds ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
      );
      error.statusCode = 413;
      throw error;
    }

    const contentType = response.ContentType || "image/png";
    const sourceExtension = sourceKey.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1];
    const extension = extensionByMimeType[contentType] || sourceExtension || "img";
    const key = `${destinationPrefix}${crypto.randomUUID()}.${extension}`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: QUOTATION_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        ACL: "public-read",
      })
    );
    uploadedKeys.push(key);
    return buildPublicUrl(key);
  }

  assertConfigured();
  const key = `${quotationImagePrefix(quotationId)}${crypto.randomUUID()}.${parsed.extension}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: QUOTATION_S3_BUCKET,
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
      async (task) => {
        try {
          return await uploadImage(quotationId, task.value, uploadedKeys);
        } catch (error) {
          if (task.type !== "logo" || !isMissingS3ObjectError(error)) throw error;
          console.warn("Quotation logo is missing from S3; saving quotation without it");
          return "";
        }
      }
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
  if (!uniqueKeys.length || !QUOTATION_S3_BUCKET) return;

  for (let index = 0; index < uniqueKeys.length; index += 1000) {
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: QUOTATION_S3_BUCKET,
        Delete: {
          Objects: uniqueKeys.slice(index, index + 1000).map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
}

async function deleteQuotationImages(quotationId) {
  if (!QUOTATION_S3_BUCKET) return;

  let continuationToken;
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: QUOTATION_S3_BUCKET,
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
  normalizeQuotationImageReferences,
  normalizeQuotationImageUrl,
  inlineQuotationImages,
  isMissingS3ObjectError,
  sanitizePdfImageReference,
  uploadQuotationImages,
};
