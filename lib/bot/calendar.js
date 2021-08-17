const { try } = require('bluebird');
const { google } = require('googleapis');

const { OAuth2 } = google.auth;

const CONFIG = require('../config/index');
const { randomGenerator } = require('../helpers/index');

const oAuth2Client_1 = new OAuth2(
  CONFIG.auth.meraki1.googleClientID,
  CONFIG.auth.meraki1.googleClientSecret
);

const oAuth2Client_2 = new OAuth2(
  CONFIG.auth.meraki2.googleClientID,
  CONFIG.auth.meraki2.googleClientSecret
);

oAuth2Client_1.setCredentials({
  refresh_token: CONFIG.auth.meraki1.authRefreshToken,
});

oAuth2Client_2.setCredentials({
  refresh_token: CONFIG.auth.meraki2.authRefreshToken,
});

const calendar_1 = google.calendar({ version: 'v3', auth: oAuth2Client_1 });
const calendar_2 = google.calendar({ version: 'v3', auth: oAuth2Client_2 });

module.exports = {
  createCalendarEvent: async (classDetails, facilitator) => {
    let eventStartTime = classDetails.start_time;
    let eventEndTime = classDetails.end_time;
    if (typeof classDetails.start_time !== 'string') {
      eventStartTime = eventStartTime.toISOString();
    }
    if (typeof classDetails.end_time !== 'string') {
      eventEndTime = eventEndTime.toISOString();
    }

    const event = {
      summary: `Class: ${classDetails.title}`,
      location: null,
      description: classDetails.description,
      start: {
        dateTime: eventStartTime.replace('Z', ''),
        timeZone: 'Asia/Kolkata',
      },
      end: {
        dateTime: eventEndTime.replace('Z', ''),
        timeZone: 'Asia/Kolkata',
      },
      // eslint-disable-next-line
      colorId: classDetails.type === 'workshop' ? 2 : classDetails.type === 'doubt_class' ? 4 : 6,
      conferenceData: {
        createRequest: {
          requestId: randomGenerator().secretId,
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
        status: {
          statusCode: 'success',
        },
      },
      organizer: {
        displayName: facilitator.name,
        email: facilitator.email,
      },
      creator: {
        email: facilitator.email,
      },
      attendees: [
        {
          email: facilitator.email,
        },
      ],
    };
    let createdEvent;
    try {
      createdEvent = await calendar_1.events.insert({
        calendarId: 'primary',
        resource: event,
        conferenceDataVersion: 1,
        sendUpdates: 'all',
      });
    } catch {
      createdEvent = await calendar_2.events.insert({
        calendarId: 'primary',
        resource: event,
        conferenceDataVersion: 1,
        sendUpdates: 'all',
      });
    }
    return createdEvent;
  },

  patchCalendarEvent: async (classDetails, attendees = null) => {
    const { calendar_event_id, title, description, start_time, end_time } = classDetails;

    let event = {};

    if (attendees) {
      event = { ...event, attendees };
    }

    let eventStartTime = start_time;
    let eventEndTime = end_time;
    if (typeof start_time !== 'string') eventStartTime = eventStartTime.toISOString();
    if (typeof end_time !== 'string') eventEndTime = eventEndTime.toISOString();
    const start = {
      dateTime: eventStartTime.replace('Z', ''),
      timeZone: 'Asia/Kolkata',
    };
    const end = {
      dateTime: eventEndTime.replace('Z', ''),
      timeZone: 'Asia/Kolkata',
    };

    event = {
      ...event,
      summary: `Class: ${title}`,
      description,
      start,
      end,
    };

    let patchedEvent;
    try {
      patchedEvent = calendar_1.events.patch({
        calendarId: 'primary',
        eventId: calendar_event_id,
        resource: event,
        sendUpdates: 'all',
      });
    } catch {
      patchedEvent = calendar_2.events.patch({
        calendarId: 'primary',
        eventId: calendar_event_id,
        resource: event,
        sendUpdates: 'all',
      });
    }
    return patchedEvent;
  },

  deleteCalendarEvent: async (eventId) => {
    try {
      return calendar_1.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all',
      });
    } catch {
      return calendar_2.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all',
      });
    }
  },
};
