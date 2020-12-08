const upload = {
  querystring: {
    type: 'object',
    properties: {
      parentId: { $ref: 'http://graasp.org/#/definitions/uuid' }
    },
    additionalProperties: false
  },
  body: {
    type: 'object',
    required: ['filename'],
    properties: {
      filename: { type: 'string' }
    },
    additionalProperties: false
  }
};

const getMetadata = {
  params: { $ref: 'http://graasp.org/#/definitions/idParam' },
};

export {
  upload,
  getMetadata
};
