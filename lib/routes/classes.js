const Joi = require('@hapi/joi').extend(require('@joi/date'));
const _ = require('lodash');
const Boom = require('@hapi/boom');
const logger = require('../../server/logger');
const botFunctions = require('../bot/actions');

const Classes = require('../models/classes');
const {
  parseISOStringToDateObj,
  dateObjToYYYYMMDDFormat,
  convertToIST,
  UTCToISTConverter,
} = require('../helpers/index');

const buildSchema = (requestType) => {
  return Joi.object({
    title: requestType === 'POST' ? Joi.string().required() : Joi.string().optional(),
    description: requestType === 'POST' ? Joi.string().required() : Joi.string().optional(),
    facilitator_id:
      requestType === 'POST' ? Joi.number().integer().greater(0).optional() : Joi.forbidden(),
    facilitator_name: requestType === 'POST' ? Joi.string().optional() : Joi.forbidden(),
    facilitator_email:
      requestType === 'POST'
        ? Joi.string()
            .optional()
            .pattern(
              // eslint-disable-next-line
              /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
            )
        : Joi.forbidden(),
    start_time:
      requestType === 'POST'
        ? Joi.date().required().min('now')
        : Joi.date()
            .optional()
            .less(Joi.ref('end_time'))
            .when('end_time', { is: Joi.exist(), then: Joi.date().required() }),
    end_time:
      requestType === 'POST'
        ? Joi.date().required().greater(Joi.ref('start_time'))
        : Joi.date().optional(),
    exercise_id: Joi.number(),
    course_id: Joi.number(),
    category_id:
      requestType === 'POST'
        ? Joi.number().integer().required()
        : Joi.number().integer().optional(),
    video_id: Joi.string().optional(),
    lang:
      requestType === 'POST'
        ? Joi.string().valid('hi', 'en', 'te', 'ta').lowercase().required()
        : Joi.string().valid('hi', 'en', 'te', 'ta').lowercase().optional(),
    type:
      requestType === 'POST'
        ? Joi.string().valid('workshop', 'doubt_class', 'cohort').required()
        : Joi.string().valid('workshop', 'doubt_class', 'cohort').optional(),
    meet_link: Joi.string(),
    calendar_event_id: Joi.string(),
    material_link: Joi.string().uri().optional(),
    max_enrolment: Joi.number().integer().greater(0).optional(),
    frequency: Joi.string().valid('DAILY', 'WEEKLY').optional(),
    on_days: Joi.array()
      .when('frequency', {
        is: Joi.exist(),
        then: Joi.array().items(
          Joi.string().valid('SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'BYMONTH')
        ),
        otherwise: Joi.forbidden(),
      })
      .optional(),
    occurrence: Joi.number()
      .when('frequency', {
        is: Joi.exist(),
        then: Joi.number().integer().greater(0),
        otherwise: Joi.forbidden(),
      })
      .max(48)
      .optional(),
    until: Joi.date()
      .when('occurrence', {
        not: Joi.exist(),
        then: Joi.date().format('YYYY-MM-DD').utc().greater(Joi.ref('end_time')),
        otherwise: Joi.forbidden(),
      })
      // users can create class for next 24 weeks only
      .max(dateObjToYYYYMMDDFormat(new Date(new Date().getTime() + 24 * 60 * 60 * 1000 * 24 * 7)))
      .optional(),
  });
};

module.exports = [
  {
    method: 'GET',
    path: '/classes/all',
    options: {
      description: 'Get a list of all classes',
      tags: ['api'],
      auth: {
        strategy: 'jwt',
      },
      validate: {
        query: Joi.object({
          startDate: Joi.date().optional(),
        }),
      },
      handler: async (request, h) => {
        const { classesService, displayService } = request.services();
        let { startDate } = request.query;
        if (startDate === undefined) {
          startDate = new Date();
        }
        const [err, allClasses] = await classesService.getAllClasses(startDate);
        if (err) {
          logger.error(JSON.stringify(err));
          return h.response(err).code(err.code);
        }
        logger.info('Get a list of all classes');
        return displayService.getUpcomingClassFacilitators(allClasses);
      },
    },
  },
  {
    method: 'POST',
    path: '/classes',
    options: {
      description: 'Creates a class and returns the created class',
      tags: ['api'],
      auth: {
        strategy: 'jwt',
      },
      validate: {
        payload: buildSchema('POST'),
        headers: Joi.object({
          role: Joi.string().valid('volunteer').optional(),
        }),
        options: { allowUnknown: true },
      },
      handler: async (request, h) => {
        const {
          classesService,
          userService,
          chatService,
          displayService,
          calendarService,
        } = request.services();
        let { payload } = request;
        const { role } = request.headers;
        let facilitator;
        const recurringEvents = [];

        if (payload.facilitator_id !== undefined) {
          const [err, user] = await userService.findById(payload.facilitator_id);
          if (err) {
            // eslint-disable-next-line
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(err));
            return h.response(err).code(err.code);
          }
          facilitator = await displayService.userProfile(user);
        } else if (
          payload.facilitator_id === undefined &&
          payload.facilitator_email !== undefined
        ) {
          facilitator = { name: payload.facilitator_name, email: payload.facilitator_email };
        } else {
          payload = {
            ...payload,
            facilitator_id: request.auth.credentials.id,
          };
          const [err, user] = await userService.findById(payload.facilitator_id);
          if (err) {
            // eslint-disable-next-line
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(err));
            return h.response(err).code(err.code);
          }
          facilitator = await displayService.userProfile(user);
        }

        if (payload.on_days) payload.on_days = payload.on_days.join(',');

        // #TODO

        try {
          const calendarEvent = await calendarService.createCalendarEvent(payload, facilitator);
          const meetLink = calendarEvent.data.hangoutLink.split('/').pop();
          // If the intent is to create a recurring event
          if (payload.frequency) {
            const allEvents = await calendarService.getRecurringInstances(
              calendarEvent.data.id,
              payload.facilitator_id,
              facilitator.email
            );
            // capture all instances of a recurring event
            recurringEvents.push(...allEvents.data.items);
          }
          payload = {
            ...payload,
            calendar_event_id: calendarEvent.data.id,
            meet_link: meetLink,
          };
        } catch (err) {
          /* eslint-disable */
          logger.info('Calendar event error' + err);
          /* eslint-enable */
          return h
            .response({
              error: 'true',
              message: 'Unable to create class, please contact platform@navgurukul.org',
            })
            .code(400);
        }

        const recurringPayload = [];
        if (recurringEvents.length > 0) {
          const privateChat = {
            visibility: 'private',
            roomAliasName:
              payload.title.replace(/[^a-zA-Z]/g, '') +
              facilitator.name.replace(/[^a-zA-Z]/g, '') +
              Math.floor(Math.random() * 1000),
            name: payload.title,
            topic: `${payload.title} by ${facilitator.name}`,
          };
          const createdRoom = await botFunctions.createARoom(privateChat);
          const cohort_room = createdRoom.room_id;
          const [error, user] = await userService.getUserByEmail(request.auth.credentials.email);
          if (error) {
            // eslint-disable-next-line
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(error));
          }
          await chatService.addUsersToMerakiClass(
            cohort_room,
            `@${user[0].chat_id}:navgurukul.org`
          );
          await chatService.sendInitialMessageToFacilitator(cohort_room, user[0].id);
          const recurringMetadata = (({
            frequency,
            on_days,
            occurrence,
            until,
            calendar_event_id,
            cohort_room_id,
          }) => ({
            frequency,
            on_days,
            occurrence,
            until,
            calendar_event_id,
            cohort_room_id,
          }))(payload);
          recurringMetadata.cohort_room_id = cohort_room;
          const [err, recurringClassEntry] = await classesService.createRecurringEvent(
            recurringMetadata
          );
          if (err) {
            // eslint-disable-next-line
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(err));
            return h.response(err).code(err.code);
          }
          recurringEvents.forEach((e) => {
            const { frequency, on_days, occurrence, until, ...instances } = payload;
            const startTimeParsed = parseISOStringToDateObj(e.start.dateTime);
            const endTimeParsed = parseISOStringToDateObj(e.end.dateTime);
            instances.start_time = UTCToISTConverter(startTimeParsed);
            instances.end_time = UTCToISTConverter(endTimeParsed);
            instances.calendar_event_id = e.id;
            instances.recurring_id = recurringClassEntry.id;
            recurringPayload.push(instances);
          });
          const [errInRecurring, createdClasses] = await classesService.createClass(
            recurringPayload,
            role
          );
          if (errInRecurring) {
            // eslint-disable-next-line
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(errInRecurring));
            return h.response(errInRecurring).code(errInRecurring.code);
          }
          logger.info(`reccuring classes created by- ${request.auth.credentials.id}`);
          return createdClasses;
        }
        const { frequency, occurrence, until, on_days, ...payloadCopy } = payload;
        payloadCopy.start_time = convertToIST(payloadCopy.start_time);
        payloadCopy.end_time = convertToIST(payloadCopy.end_time);

        const [errInSingle, singleClass] = await classesService.createClass([payloadCopy], role);
        if (errInSingle) {
          // eslint-disable-next-line
          logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(errInSingle));
          return h.response(errInSingle).code(errInSingle.code);
        }
        logger.info(`single class created by- ${request.auth.credentials.id}`);
        return singleClass;
      },
    },
  },
  {
    method: 'GET',
    path: '/classes/{classId}',
    options: {
      description: 'Get details of a class',
      tags: ['api'],
      auth: {
        strategy: 'jwt',
        mode: 'optional',
      },
      validate: {
        params: Joi.object({
          classId: Classes.field('id'),
        }),
      },
      handler: async (request, h) => {
        const singleClass = [];
        const { classesService, displayService } = request.services();
        const { classId } = request.params;
        const userId = request.auth.credentials.id;
        const [err, classById] = await classesService.getClassById(classId);
        if (err) {
          // eslint-disable-next-line
          logger.error(`classId- ${classId} ` + JSON.stringify(err));
          return h.response(err).code(err.code);
        }
        singleClass.push(classById);
        const singleClassWithFacilitator = await displayService.getUpcomingClassFacilitators(
          singleClass
        );
        const classDetails = await displayService.getClassDetails(
          singleClassWithFacilitator,
          userId
        );
        logger.info(`Get details of a class by id- ${classId}`);
        return classDetails;
      },
    },
  },
  {
    method: 'PUT',
    path: '/classes/{classId}',
    options: {
      description: 'Updates a class and returns it as response',
      tags: ['api'],
      auth: {
        strategy: 'jwt',
      },
      validate: {
        params: Joi.object({
          classId: Classes.field('id'),
        }),
        payload: buildSchema('PUT'),
        headers: Joi.object({
          'update-all': Joi.boolean().optional(),
        }),
        options: { allowUnknown: true },
      },
      handler: async (request, h) => {
        const { classesService, displayService, userService, calendarService } = request.services();
        const { classId } = request.params;
        const [errWhileFetchingSingle, singleClass] = await classesService.getClassById(classId);
        if (errWhileFetchingSingle) {
          /* eslint-disable */
          logger.error(
            `id- ${request.auth.credentials.id}: ` + JSON.stringify(errWhileFetchingSingle)
          );
          /* eslint-enable */
          return h.response(errWhileFetchingSingle).code(errWhileFetchingSingle.code);
        }

        // If a recurring event is to be updated as a whole
        if (request.headers['update-all'] && singleClass.recurring_id !== null) {
          const [
            errWhileFetchingRecurring,
            recurringClasses,
          ] = await classesService.getClassesByRecurringId(singleClass.recurring_id);
          if (errWhileFetchingRecurring) {
            /* eslint-disable */
            logger.error(
              `id- ${request.auth.credentials.id}: ` + JSON.stringify(errWhileFetchingRecurring)
            );
            /* eslint-enable */
            return h.response(errWhileFetchingRecurring).code(errWhileFetchingRecurring.code);
          }
          const createPayload = {};
          /**
           * Creating a new payload with values provided in request.payload for all valid classes model fields
           * If values are not provided in payload, values from older data is set
           */
          Classes.fields().forEach((f) => {
            if (request.payload[f] !== undefined) {
              createPayload[f] = request.payload[f];
            } else {
              createPayload[f] = singleClass[f];
            }
          });
          // Adding extra values of provided payload in actual payload (which are not a part of classes model)
          Object.keys(request.payload).forEach((k) => {
            if (createPayload[k] === undefined) {
              createPayload[k] = request.payload[k];
            }
          });

          let facilitator;
          // Setting facilitator for corresponding class, to create a calendar event
          if (createPayload.facilitator_id) {
            const [err, user] = await userService.findById(createPayload.facilitator_id);
            if (err) {
              /* eslint-disable */
              logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(err));
              return h.response(err).code(err.code);
            }
            const withFacilitorData = await displayService.userProfile(user);
            facilitator = { name: withFacilitorData.name, email: withFacilitorData.email };
          } else if (
            !createPayload.facilitator_id &&
            createPayload.facilitator_email !== undefined
          ) {
            facilitator = {
              name: createPayload.facilitator_name,
              email: createPayload.facilitator_email,
            };
          }

          if (createPayload.on_days) createPayload.on_days = createPayload.on_days.join(',');

          const recurringEvents = [];
          const allRegs = [];

          // Creating a list of original attendees / those who enrolled for the class
          recurringClasses.forEach((c) => {
            allRegs.push(...c.registrations);
          });
          const allRegIds = [];
          createPayload.attendees = [];
          if (allRegs.length > 0) {
            allRegs.forEach((rId) => {
              if (allRegIds.indexOf(rId.user_id) < 0) {
                allRegIds.push(rId.user_id);
              }
            });
            const [errInGettingEmail, originalAttendees] = await userService.findByListOfIds(
              allRegIds,
              'email'
            );
            if (errInGettingEmail) {
              /* eslint-disable */
              logger.error(
                `id- ${request.auth.credentials.id}: ` + JSON.stringify(errInGettingEmail)
              );
              /* eslint-enable */
              return h.response(errInGettingEmail).code(errInGettingEmail.code);
            }
            createPayload.attendees.push(...originalAttendees);
          }

          if (_.findIndex(createPayload.attendees, { email: facilitator.email }) < 0) {
            createPayload.attendees.push({ email: facilitator.email });
          }

          try {
            // Deleting the present calendar event
            await calendarService.deleteCalendarEvent(
              singleClass.parent_class.calendar_event_id,
              singleClass.facilitator_id,
              facilitator.email
            );
            // Creating a new calendar event to replace the deleted one with updated data
            const calendarEvent = await calendarService.createCalendarEvent(
              createPayload,
              facilitator
            );
            const meetLink = calendarEvent.data.hangoutLink.split('/').pop();
            // Getting all recurring instances of the calendar event
            const allEvents = await calendarService.getRecurringInstances(
              calendarEvent.data.id,
              facilitator.id,
              facilitator.email
            );
            // Capturing all instances of a recurring event
            recurringEvents.push(...allEvents.data.items);
            // Updating the payload with new calendar event id and meet link
            createPayload.calendar_event_id = calendarEvent.data.id;
            createPayload.meet_link = meetLink;
          } catch (err) {
            /* eslint-disable */
            logger.error(`Calendar event error` + JSON.stringify(err));
            /* eslint-enable */
            return h
              .response({
                error: 'true',
                message: 'Unable to edit class, please contact platform@navgurukul.org',
              })
              .code(400);
          }
          // Deleting individual classes from the classes table
          const deleteClasses = async () => {
            const [errorInDeletingAll, deletedClasses] = await classesService.deleteMultipleClasses(
              singleClass.recurring_id
            );
            if (errorInDeletingAll) {
              /* eslint-disable */
              logger.error(
                `id- ${request.auth.credentials.id}: ` + JSON.stringify(errorInDeletingAll)
              );
              return h.response(errorInDeletingAll).code(errorInDeletingAll.code);
            }
            return deletedClasses;
          };
          const checkIfClassesDeleted = await h.context.transaction(deleteClasses);
          if ('error' in checkIfClassesDeleted) {
            logger.error(
              `id- ${request.auth.credentials.id}: ` + JSON.stringify(checkIfClassesDeleted)
            );
            return checkIfClassesDeleted;
          }

          // Creating payload for `recurring_classes` table entry
          const recurringMetadata = (({
            frequency,
            on_days,
            occurrence,
            until,
            calendar_event_id,
          }) => ({
            frequency,
            on_days,
            occurrence,
            until,
            calendar_event_id,
          }))(createPayload);

          /**
           * Inserting data in `recurring_classes` row
           * Rows could be simply updated instead, but when we delete multiple classes,
           * corresponding linked row in `recurring_classes` table for them is also deleted
           */

          const [err, recurringClassEntry] = await classesService.createRecurringEvent(
            recurringMetadata
          );
          if (err) {
            logger.error(JSON.stringify(err));
            return h.response(err).code(err.code);
          }
          const recurringPayload = [];
          const registrationPayload = [];

          // Creating multiple payloads for each recurring_class instance
          recurringEvents.forEach((e) => {
            const {
              id,
              frequency,
              on_days,
              occurrence,
              until,
              attendees,
              ...instances
            } = createPayload;
            const startTimeParsed = parseISOStringToDateObj(e.start.dateTime);
            const endTimeParsed = parseISOStringToDateObj(e.end.dateTime);

            instances.start_time = UTCToISTConverter(startTimeParsed);
            instances.end_time = UTCToISTConverter(endTimeParsed);

            instances.calendar_event_id = e.id;
            instances.recurring_id = recurringClassEntry.id;
            const filteredInstance = _.omitBy(instances, _.isNull);
            recurringPayload.push(filteredInstance);
          });

          // Creating new classes in batch
          const [errInRecurring, createdClasses] = await classesService.createClass(
            recurringPayload
          );
          if (errInRecurring) {
            logger.error(`id- ${request.auth.credentials.id}: ` + JSON.stringify(errInRecurring));
            return h.response(errInRecurring).code(errInRecurring.code);
          }

          // Creating payload for all older registrations for recurring class
          if (allRegIds.length > 0) {
            _.forEach(createdClasses, (c) => {
              _.forEach(allRegIds, (id) => {
                registrationPayload.push({
                  user_id: id,
                  class_id: c.id,
                  registered_at: new Date(),
                });
              });
            });

            // Inserting older registrations for each new class
            // eslint-disable-next-line
            const [errWhileRegistering, registered] = await classesService.registerToClassById(
              registrationPayload
            );
            if (errWhileRegistering) {
              logger.error(
                `id- ${request.auth.credentials.id}: ` + JSON.stringify(errWhileRegistering)
              );
              return h.response(errWhileRegistering).code(errWhileRegistering.code);
            }
          }
          logger.info(`class updated by- ${request.auth.credentials.id}`);
          return createdClasses;
        }

        // If a single class is updated
        if (request.payload.start_time)
          request.payload.start_time = convertToIST(request.payload.start_time);
        if (request.payload.end_time)
          request.payload.end_time = convertToIST(request.payload.end_time);

        const [err, patchedClass] = await classesService.updateClass(classId, request.payload);
        if (err) {
          logger.error(JSON.stringify(err));
          return h.response(err).code(err.code);
        }
        try {
          await calendarService.patchCalendarEvent(patchedClass);
        } catch {
          // eslint-disable-next-line
          logger.error(`id- ${request.auth.credentials.id}: Calendar Event error`);
        }
        logger.info(`single class updated by- ${request.auth.credentials.id}`);
        return [patchedClass];
      },
    },
  },
  {
    method: 'DELETE',
    path: '/classes/{classId}',
    options: {
      description: 'Deletes a class (Dashboard Admin and class creators only)',
      tags: ['api'],
      auth: {
        strategy: 'jwt',
      },
      validate: {
        params: Joi.object({
          classId: Classes.field('id'),
        }),
        headers: Joi.object({
          'delete-all': Joi.boolean().optional(),
        }),
        options: { allowUnknown: true },
      },
      handler: async (request, h) => {
        const { classesService, userService, displayService, calendarService } = request.services();
        const [errInFetching, classToDelete] = await classesService.getClassById(
          request.params.classId
        );

        const { artifacts: token } = request.auth;
        const [errInUser, user] = await userService.findById(token.decoded.id);
        if (errInUser) {
          logger.error(`id- ${request.auth.credentials}` + JSON.stringify(errInUser));
          return h.response(errInUser).code(errInUser.code);
        }
        const userWithRoles = await displayService.userProfile(user);

        if (errInFetching) {
          logger.error(`id- ${request.auth.credentials}` + JSON.stringify(errInFetching));
          return h.response(errInFetching).code(errInFetching.code);
        }
        if (
          !(
            userWithRoles.rolesList.indexOf('classAdmin') > -1 ||
            userWithRoles.rolesList.indexOf('admin') > -1 ||
            // eslint-disable-next-line
            userWithRoles.id == classToDelete.facilitator_id
          )
        ) {
          throw Boom.forbidden(`You do not have rights to delete this class.`);
        }
        let calendarEventId;
        if (request.headers['delete-all'] && classToDelete.parent_class) {
          calendarEventId = classToDelete.parent_class.calendar_event_id;
        } else {
          calendarEventId = classToDelete.calendar_event_id;
        }
        try {
          await calendarService.deleteCalendarEvent(
            calendarEventId,
            classToDelete.facilitator_id,
            classToDelete.facilitator_email
          );
        } catch {
          // eslint-disable-next-line
          logger.error(`id- ${request.auth.credentials.id}: Calendar Event error`);
          // console.log('Calendar event error');
        }

        if (request.headers['delete-all'] && classToDelete.parent_class) {
          const deleteClasses = async () => {
            const [errorInDeletingAll, deletedClasses] = await classesService.deleteMultipleClasses(
              classToDelete.recurring_id
            );
            if (errorInDeletingAll) {
              logger.error(`id- ${request.auth.credentials}` + JSON.stringify(errorInDeletingAll));
              return h.response(errorInDeletingAll).code(errorInDeletingAll.code);
            }
            logger.info('deletedClasses');
            return deletedClasses;
          };

          const checkIfClassesDeleted = await h.context.transaction(deleteClasses);

          if ('error' in checkIfClassesDeleted) {
            logger.error(JSON.stringify(checkIfClassesDeleted));
            return checkIfClassesDeleted;
          }
          logger.info('checkIfClassDeleted');
          return checkIfClassesDeleted;
        }

        const deleteAClass = async () => {
          const [errInDeleting, deletedClass] = await classesService.deleteClass(
            request.params.classId
          );
          if (errInDeleting) {
            logger.error(`id- ${request.auth.credentials}` + JSON.stringify(errInDeleting));
            return h.response(errInDeleting).code(errInDeleting.code);
          }
          logger.info(`Class deleted by id- ${request.auth.credentials}`);
          return deletedClass;
        };

        const checkIfClassDeleted = await h.context.transaction(deleteAClass);

        if ('error' in checkIfClassDeleted) {
          logger.error(JSON.stringify(checkIfClassDeleted));
          return checkIfClassDeleted;
        }
        logger.info('checkIfClassDeleted');
        return checkIfClassDeleted;
      },
    },
  },
];
