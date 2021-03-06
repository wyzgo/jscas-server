'use strict'

// This an implementation of the functionality described in
// https://github.com/apereo/cas/blob/92ea88/docs/cas-server-documentation/protocol/SAML-Protocol.md
//
// Such functionality is not really a part of the CAS protocol, but it is
// assumed present by some service providers (e.g. version 9 of a major Student
// Information System product).
//
// This protocol is basically https://en.wikipedia.org/wiki/SAML_1.1#Browser/POST_Profile

// EXPERIMENTAL: this feature is considered experimental.

const crypto = require('crypto')
const xml = require('../../xml')
const xmlContentParser = require('./contentTypeParser')

function samlValidateRoutePlugin (fastify, options, next) {
  const sessionMaxAge = options.sessionMaxAge
  const enableBanner9Hack = options.banner9Hack

  async function samlValidate (req, reply) {
    const serviceUrl = req.query.TARGET
    const serviceTicketId = req.body.ticket

    const service = await fastify.validateService(serviceUrl)
    if (service.isError) {
      req.log.error('failed to validate service: %s', service.message)
      req.log.debug(service.stack)
      reply.type('text/xml')
      return xml.saml11Failure.renderToString({
        requestId: req.body.id,
        issued: (new Date()).toISOString(),
        responseId: crypto.randomBytes(16).toString('hex'),
        statusCode: service.code,
        stausMessage: 'Missing required parameter(s)'
      })
    }

    let serviceTicket = await fastify.validateST(serviceTicketId)
    if (serviceTicket.isError) {
      req.log.error('failed to validate service ticket: %s', serviceTicket.message)
      req.log.debug(serviceTicket.stack)
      reply.type('text/xml')
      return xml.saml11Failure.renderToString({
        requestId: req.body.id,
        issued: (new Date()).toISOString(),
        responseId: crypto.randomBytes(16).toString('hex'),
        statusCode: serviceTicket.code,
        statusMessage: `Ticket ${serviceTicketId} was not recognized`
      })
    }

    serviceTicket = await fastify.invalidateST(serviceTicketId)
    if (serviceTicket.isError) {
      req.log.error('failed to invalidate service ticket: %s', serviceTicket.message)
      req.log.debug(serviceTicket.stack)
      reply.type('text/xml')
      return xml.saml11Failure.renderToString({
        requestId: req.body.id,
        issued: (new Date()).toISOString(),
        responseId: crypto.randomBytes(16).toString('hex'),
        statusCode: serviceTicket.code,
        stuatusMessage: `Service ticket ${serviceTicketId} could not be invalidated`
      })
    }

    const tgt = await fastify.getTGT(serviceTicketId)
    if (tgt.isError) {
      req.log.error('unalbe to get tgt for service: %s', serviceTicketId)
      req.log.debug(tgt.stack)
      reply.type('text/xml')
      return xml.saml11Failure.renderToString({
        requestId: req.body.id,
        issued: (new Date()).toISOString(),
        responseId: crypto.randomBytes(16).toString('hex'),
        statusCode: tgt.code,
        statusMessage: `TGT for ${serviceTicketId} could not be found`
      })
    }

    await fastify.trackService(serviceTicket, tgt, serviceUrl)

    let attributes = {}
    try {
      attributes = await fastify.jscasPlugins.attributesResolver.attributesFor(tgt.userId)
      req.log.debug('retrieved attributes: %j', attributes)
    } catch (e) {
      req.log.error('could not retrieve user attributes: %s', e.message)
      req.log.debug(e.stack)
    }

    if (enableBanner9Hack) {
      attributes.UDC_IDENTIFIER = tgt.userId
    }

    const toSendXml = xml.saml11Success.renderToString({
      username: tgt.userId,
      requestId: req.body.id,
      responseId: crypto.randomBytes(16).toString('hex'),
      assertionId: crypto.randomBytes(16).toString('hex'),
      issued: (new Date()).toISOString(),
      expires: (new Date(Date.now() + sessionMaxAge || 1000)).toISOString(),
      serviceUrl,
      attributes
    })
    if (req.log.isLevelEnabled('debug')) {
      req.log.debug('sending xml: `%s`', Buffer.from(toSendXml, 'utf8').toString('hex'))
    }
    reply.type('text/xml')
    return toSendXml
  }

  fastify.post('/samlValidate', samlValidate)
  fastify.addContentTypeParser('application/xml', {parseAs: 'string'}, xmlContentParser)
  fastify.addContentTypeParser('text/xml', {parseAs: 'string'}, xmlContentParser)

  next()
}

// Do not export with `fastify-plugin` so that the content type parsers
// will only apply to this route.
module.exports = samlValidateRoutePlugin
