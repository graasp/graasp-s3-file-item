import { FastifyPluginAsync } from 'fastify';
import { Item, UnknownExtra } from 'graasp';

import {
  upload as uploadSchema,
  getMetadata as getMetadataSchema
} from './schemas/shared';

import S3 from 'aws-sdk/clients/s3';

interface GraaspS3FileItemOptions {
  s3Region: string,
  s3Bucket: string,
  s3AccessKeyId: string,
  s3SecretAccessKey: string,
  s3UseAccelerateEndpoint?: boolean,
  s3Expiration?: number
}

interface S3FileExtra extends UnknownExtra {
  name: string,
  key: string,
  size?: number,
  contenttype?: string
}

interface IdParam { id: string }
interface ParentIdParam { parentId?: string }
interface S3UploadBody { filename: string }

const ITEM_TYPE = 's3-file';
const ORIGINAL_FILENAME_TRUNCATE_LIMIT = 100;
const randomHexOf4 = () => (Math.random() * (1 << 16) | 0).toString(16).padStart(4, '0');

const plugin: FastifyPluginAsync<GraaspS3FileItemOptions> = async (fastify, options) => {
  const {
    s3Region: region,
    s3Bucket: bucket,
    s3AccessKeyId: accessKeyId,
    s3SecretAccessKey: secretAccessKey,
    s3UseAccelerateEndpoint: useAccelerateEndpoint = false,
    s3Expiration: expiration = 60 // 1 minute,
  } = options;
  const { items: { taskManager }, taskRunner: runner, log: defaultLogger } = fastify;

  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('graasp-s3-file-item: mandatory options missing');
  }

  // TODO: a Cache-Control policy is missing and
  // it's necessary to check how that policy is kept while copying
  // also: https://www.aaronfagan.ca/blog/2017/how-to-configure-aws-lambda-to-automatically-set-cache-control-headers-on-s3-objects/
  const s3 = new S3({
    region, useAccelerateEndpoint,
    credentials: { accessKeyId, secretAccessKey }
  }); // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html

  // register post delete handler to remove the s3 file object after item delete
  const deleteItemTaskName = taskManager.getDeleteTaskName();
  runner.setTaskPostHookHandler<Item<S3FileExtra>>(deleteItemTaskName, (item, _actor, { log = defaultLogger }) => {
    const { type: itemType, extra: { key } } = item;
    if (itemType !== ITEM_TYPE) return;

    s3.deleteObject({ Bucket: bucket, Key: key }).promise()
      // using request's logger instance. can't use arrow fn because 'log.error' uses 'this'.
      .catch(function (error) {
        log.error(error, `graasp-s3-file-item: failed to delete s3 object \'${key}\'`);
      });
  });

  // register pre copy handler to make a copy of the s3 file object before the copy is actually created
  const copyItemTaskName = taskManager.getCopyTaskName();
  runner.setTaskPreHookHandler<Item<S3FileExtra>>(copyItemTaskName, async (item, actor) => {
    const { id, type: itemType, extra } = item; // full copy with new `id`
    if (!id || itemType !== ITEM_TYPE || !extra) return;

    const { key, contenttype, name } = extra;
    const metadata: S3.Metadata = {
      member: actor.id,
      item: id
    };
    const newKey = `${randomHexOf4()}/${randomHexOf4()}/${randomHexOf4()}-${Date.now()}`;

    const params: S3.CopyObjectRequest = {
      CopySource: `${bucket}/${key}`,
      Bucket: bucket,
      Key: newKey,
      Metadata: metadata,
      MetadataDirective: 'REPLACE',
      ContentDisposition: `attachment; filename="${name}"`,
      ContentType: contenttype,
      CacheControl: 'no-cache' // TODO: improve?
    };

    // TODO: the Cache-Control policy metadata is lost. try to set a global policy for the bucket in aws.
    await s3.copyObject(params).promise();

    extra.key = newKey;
  });

  // trigger s3 file upload
  fastify.post<{ Querystring: ParentIdParam, Body: S3UploadBody }>(
    '/s3-upload', { schema: uploadSchema },
    async ({ member, query: { parentId }, body: { filename }, log }) => {
      const name = filename.substring(0, ORIGINAL_FILENAME_TRUNCATE_LIMIT);
      const key = `${randomHexOf4()}/${randomHexOf4()}/${randomHexOf4()}-${Date.now()}`;

      const itemData: Partial<Item<S3FileExtra>> = {
        name,
        type: ITEM_TYPE,
        extra: { name: filename, key }
      };

      // create item
      const task = taskManager.createCreateTask(member, itemData, parentId);
      const item = await runner.runSingle(task, log);

      // add member and item info to S3 object metadata
      const metadata = { member: member.id, item: item.id };

      const params = {
        Bucket: bucket,
        Key: key,
        Expires: expiration,
        Metadata: metadata
        // currently does not work. more info here: https://github.com/aws/aws-sdk-js/issues/1703
        // the workaround is to do the upload (PUT) from the client with this request header.
        // ContentDisposition: `attachment; filename="<filename>"`
        // also does not work. should the client always send it when uploading the file?
        // CacheControl: 'no-cache'
      };

      // request s3 signed url to upload file
      try {
        const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
        return { item, uploadUrl };
      } catch (error) {
        log.error(error, 'graasp-s3-file-item: failed to get signed url for upload');
        throw error;
      }
    }
  );

  // get (and update) s3 file item metadata - item's 'extra'
  fastify.get<{ Params: IdParam }>(
    '/:id/s3-metadata', { schema: getMetadataSchema },
    async ({ member, params: { id }, log }) => {
      const task = taskManager.createGetTask<S3FileExtra>(member, id);
      const { extra } = await runner.runSingle(task, log);
      const { size, contenttype, key } = extra;

      if ((size === 0 || size) && contenttype) return extra;

      let itemData;
      const params: S3.HeadObjectRequest = { Bucket: bucket, Key: key };

      try {
        const { ContentLength, ContentType } = await s3.headObject(params).promise();
        itemData = { extra: { size: ContentLength, contenttype: ContentType } };
      } catch (error) {
        log.error(error, 'graasp-s3-file-item: failed to get s3 object metadata');
        throw error;
      }

      const updateTask = taskManager.createUpdateTask(member, id, itemData);
      const { extra: metadata } = await runner.runSingle(updateTask, log);

      return metadata;
    }
  );
};

export default plugin;
