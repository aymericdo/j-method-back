'use strict';
import express from 'express';
import webpush from 'web-push';
const app = express();
import bodyParser from 'body-parser';
import schedule from 'node-schedule';
import cors from 'cors';
import dotenv from 'dotenv'
dotenv.config()
import mongoose from 'mongoose';
import moment from 'moment';
import NodeCache from 'node-cache';
const myCache = new NodeCache();
import { google } from 'googleapis';
import Fuse from 'fuse.js'
const PORT = process.env.PORT || 3000;
import { backOff } from "exponential-backoff";

const router = express.Router();

app.use(cors());
app.use(express.json({
  type: ['application/json', 'text/plain']
}));

const uri = process.env.MONGODB_URI;
const client = mongoose.createConnection(uri);

const CourseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: false },
  email: { type: String, required: true },
  difficulties: { type: String, required: true },
  date: { type: Date, required: true },
  reminders: { type: [Date], required: false },
  ids: { type: [String], required: false },
  folder: { type: String, require: false },
  hidden: { type: Boolean, require: false },
});

const NotificationSchema = new mongoose.Schema({
  course: { type: CourseSchema, required: true },
  date: { type: Date, required: true },
  durationBefore: { type: Number, required: true },
  isOnPauseSince: { type: Date, required: false },
});

const RushSchema = new mongoose.Schema({
  email: { type: String, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  ids: { type: [String], required: true },
  list: { type: [Object], required: true },
  isDayRevision: { type: Boolean, required: true },
}, { timestamps: true });

const SubscriptionSchema = new mongoose.Schema({
  email: { type: String, required: true },
  sub: {
    endpoint: { type: String, required: true },
    expirationTime: { type: String, required: false },
    keys: {
      auth: { type: String, required: true },
      p256dh: { type: String, required: true },
    },
  }
});

const SettingSchema = new mongoose.Schema({
  email: { type: String, required: true },
  maxCoursesNumber: { type: Number, required: true, default: 10 },
});

const WorkDoneSchema = new mongoose.Schema({
  course: { type: CourseSchema, required: true },
  date: { type: Date, required: true },
  isFromWE: { type: Boolean, required: true }
}, { timestamps: true });

const WeekendRevisionSchema = new mongoose.Schema({
  course: { type: CourseSchema, required: true },
  date: { type: Date, required: true },
  googleId: { type: String, required: true },
});

const CourseModel = client.model('courses', CourseSchema);
const NotificationModel = client.model('notifications', NotificationSchema);
const RushModel = client.model('rush', RushSchema);
const SubscriptionModel = client.model('subscriptions', SubscriptionSchema);
const SettingModel = client.model('settings', SettingSchema);
const WorkDoneModel = client.model('workdone', WorkDoneSchema);
const WeekendRevisionModel = client.model('weekendRevision', WeekendRevisionSchema);

const vapidKeys = {
  publicKey: "BA0IrWNjeSUg-vrORw1qaiMZ4-echF259O25I42NywBlbC3f7OzdiJjooH27nOzjtID5EoQ4pZO1wOo7lzwi7iQ",
  privateKey:"Wev87nA92dTFhnr9HFTTDDS7zE-4GMtuxFHS8NokVCU",
};

webpush.setVapidDetails(
  'mailto:aymeric.dominique@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

const schedulers = {};

const colors = {
  YELLOW: 5,
  GREEN: 2,
  PINK: 4,
  ORANGE: 6,
  TURQUOISE: 7,
  RED: 11,
};

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const scopes = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

async function refreshAccessTokenFromCode(token) {
  try {
    const { tokens } = await oauth2Client.refreshToken(token)
    return tokens;
  } catch (err) {
    throw err.response.data;
  }
}

async function getAccessTokenFromCode(code) {
  try {
    const { tokens } = await oauth2Client.getToken(code)
    return tokens;
  } catch (err) {
    throw err.response.data;
  }
}

async function getGoogleUserInfo(tokens) {
  try {
    oauth2Client.setCredentials(tokens);

    const profile = google.oauth2({
      auth: oauth2Client, // authorized oauth2 client 
      version: 'v2'
    });

    const userInfo = await profile.userinfo.v2.me.get({})

    return userInfo.data
  } catch (err) {
    throw err;
  }
}

async function cacheToken(tokens) {
  try {
    const data = await getGoogleUserInfo(tokens);
    const expiryDate = tokens.expiry_date;
    const accessToken = tokens.access_token;
    const expiresIn = expiryDate - Date.now();
    myCache.set(accessToken, { ...data, expiryDate, tokens }, expiresIn / 1000);

    return accessToken;
  } catch (err) {
    throw err;
  }
}

function createRush(email, startDate, endDate, isDayRevision, indexToStart = 0) {
  myCache.set(`loading-rush-${email}`);
  RushModel.find({ email }).then((docs) => {
    const googleIds = docs.flatMap(doc => doc.ids)
    Promise.all(googleIds.filter(Boolean).map((id) => {
      return deleteEvent(oauth2Client, id);
    })).then(() => {
      RushModel.deleteMany({ email }).then((numRemoved) => {
        let stillHaveTime = true;

        const momentEndDate = moment(endDate).set({ hour: 8, minute: 0, second: 0 });
        const start = moment(startDate).set({ hour: 8, minute: 0, second: 0 });
        const events = [];
        const list = [];
        let currentIndex = indexToStart;

        CourseModel.find({ email }).then((courses) => {
          while (stillHaveTime) {
            for (let index = 0; index < courses.length; ++index) {
              const course = courses[index];
              if (currentIndex > 0) {
                currentIndex -= 1;
                return;
              }

              if (!stillHaveTime) { return; }

              const end =
                (isDayRevision) ?
                  (course.difficulties === 'tough') ?
                    moment(start).add(1, 'days')
                  :
                    moment(start)
              :
                moment(start).add(1, 'hours');

              let res = {
                summary: course.name,
                description: course.description,
                colorId: colors.YELLOW,
                reminders: {
                  useDefault: false,
                  overrides: [
                    { method: 'popup', minutes: 240 },
                  ],
                },
              };

              if (isDayRevision) {
                res = {
                  ...res,
                  start: {
                    date: start.format('YYYY-MM-DD'),
                    timeZone: 'Europe/Paris'
                  },
                  end: {
                    date: ((isDayRevision && course.difficulties === 'tough') ?
                      end.clone().add(1, 'days') // hack to represent two days in google agenda
                    :
                      end
                    ).format('YYYY-MM-DD'),
                    timeZone: 'Europe/Paris'
                  },
                  colorId: colors.TURQUOISE,
                };
              } else {
                res = {
                  ...res,
                  start: {
                    dateTime: start.format(),
                    timeZone: 'Europe/Paris'
                  },
                  end: {
                    dateTime: end.format(),
                    timeZone: 'Europe/Paris'
                  },
                };
              }

              if (isDayRevision) {
                start.add((course.difficulties === 'tough') ? 2 : 1, 'days');
              } else {
                start.add(1, 'hours');
                if (start.hours() === 12 && start.minutes() === 0) {
                  start.add(2, 'hours');
                }

                if (start.hours() === 18 && start.minutes() === 0) {
                  start.add(1, 'day').set({ hour: 8, minute: 0, second: 0 });
                }
              }

              list.push([isDayRevision ? end.format('YYYY-MM-DD') : end.format(), index]);

              events.push(res);

              if (start.isSameOrAfter(momentEndDate)) {
                stillHaveTime = false;
                return null;
              }
            }
          }

          Promise.all(events.map((event, index) => {
            return insertEvents(oauth2Client, event);
          })).then(ids => {
            const rush = new RushModel({
              startDate,
              endDate,
              isDayRevision,
              email,
              ids,
              list,
            })

            rush.save().then(() => {
              myCache.del(`loading-rush-${email}`);
            })
          });
        });
      });
    });
  })
}

router.get('/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });

  res.status(200).json(url)
});

router.post('/sign-in', (req, res) => {
  if (!req.body.code) {
    res.sendStatus(403);
  }

  getAccessTokenFromCode(req.body.code)
    .then(async (tokens) => {
      const accessToken = await cacheToken(tokens)
      res.status(200).json(accessToken);
    })
    .catch((err) => {
      res.status(401).json(err);
    });
});

router.get('/refresh-token', (req, res) => {
  refreshAccessTokenFromCode(req.headers.token)
    .then(async (tokens) => {
      const accessToken = await cacheToken(tokens)
      res.status(200).json(accessToken);
    })
    .catch((err) => {
      console.log(err)
      res.status(403).json({ name: "TokenRevokedError" });
    });
});

async function insertEvents(auth, event) {
  const calendar = google.calendar({ version: 'v3', auth });
  const randDelay = Math.floor(Math.random()*1000)
  try {
    const result = await backOff(() => {
      return calendar.events.insert({
        auth: auth,
        calendarId: 'primary',
        resource: event,
      });
    }, { jitter: 'full', numOfAttempts: 20, maxDelay: 32000, delayFirstAttempt: true, startingDelay: randDelay });

    return result.data.id;
  } catch (err) {
    console.log('There was an error contacting the Calendar service: ' + err);
    return;
  }
}

async function patchEvents(auth, eventId, resource) {
  const calendar = google.calendar({ version: 'v3', auth });
  const randDelay = Math.floor(Math.random()*1000)
  try {
    const result = await backOff(() => calendar.events.patch({
      auth: auth,
      calendarId: 'primary',
      eventId: eventId,
      resource,
    }), { jitter: 'full', numOfAttempts: 20, maxDelay: 32000, delayFirstAttempt: true, startingDelay: randDelay });

    return result.data.id;
  } catch (err) {
    console.log('There was an error contacting the Calendar service: ' + err);
    return;
  }
}

async function deleteEvent(auth, id) {
  const calendar = google.calendar({ version: 'v3', auth });
  const randDelay = Math.floor(Math.random()*1000)
  try {
    await backOff(() => calendar.events.delete({
      auth: auth,
      calendarId: 'primary',
      eventId: id,
    }), { jitter: 'full', numOfAttempts: 20, maxDelay: 32000, delayFirstAttempt: true, startingDelay: randDelay });
  } catch (err) {
    console.log('There was an error contacting the Calendar service: ' + err);
    return;
  }
}

router.post('/courses', (req, res) => {
  const email = req.userData.email

  const course = req.body
  const reminders = [];
  if (req.body.sendToGoogleCalendar) {
    const now = moment.parseZone(req.headers.now)
    const nowHour = now.hour();
    const startDay = nowHour < 3 ? 0 : 1;
    reminders.push(now.add(startDay, 'day').format('YYYY-MM-DD'));
    if (req.body.difficulties === 'tough') {
      reminders.push(now.add(startDay + 1, 'day').format('YYYY-MM-DD'));
    }
    reminders.push(now.add(startDay + 4, 'day').format('YYYY-MM-DD'));
    reminders.push(now.add(startDay + 14, 'day').format('YYYY-MM-DD'));
    reminders.push(now.add(startDay + 29, 'day').format('YYYY-MM-DD'));
  }

  oauth2Client.setCredentials(req.userData.tokens);

  const description = `${course.description} (${course.difficulties === 'tough' ? 'Difficile' : 'Facile'})`;

  Promise.all(reminders.map((reminder, index) => {
    const event = {
      summary: `${course.name} (${index + 1})`,
      description,
      start: {
          date: reminder,
          timeZone: 'Europe/Paris',
      },
      end: {
          date: moment(reminder).add(1, 'day').format('YYYY-MM-DD'),
          timeZone: 'Europe/Paris',
      },
      reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 240 },
          ],
      },
    };

    return insertEvents(oauth2Client, event);
  })).then(ids => {
    const course = new CourseModel({
      ...req.body,
      description,
      email,
      ids,
      reminders,
    });
  
    course.save().then(() => {
      if (req.body.sendToRush) {
        RushModel.findOne({ email }).then((doc) => {
          const { startDate, endDate, isDayRevision } = doc;
          const currentItemPlusOne = doc.list.find(item => moment(item[0]).isSameOrAfter(moment()));
    
          const indexToStart = currentItemPlusOne ? currentItemPlusOne[1] : 0;
    
          createRush(email, startDate, endDate, isDayRevision, indexToStart);
        });
      }

      res.status(200).json(course)
    });
  });
});

router.patch('/courses/:courseId', (req, res) => {
  const email = req.userData.email
  const courseId = req.params.courseId
  const course = req.body

  oauth2Client.setCredentials(req.userData.tokens);
  const googleIds = course.ids || []
  Promise.all(googleIds.filter(Boolean).map((id) => {
    return patchEvents(oauth2Client, id, { description: course.description })
  })).then(() => {
    CourseModel.findOneAndUpdate(
      { email, _id: courseId },
      {
        $set: {
          description: course.description,
          folder: course.folder,
          hidden: course.hidden,
        }
      },
      { new: true }).then((doc) => {
      res.status(200).json(doc)
    });
  })
});

router.get('/courses', async (req, res) => {
  const email = req.userData.email
  const courseFilter = req.query.courseFilter

  const docs = await CourseModel.find({ email });

  if (courseFilter && courseFilter.length > 2) {
    const options = {
      // isCaseSensitive: false,
      // includeScore: false,
      // shouldSort: true,
      includeMatches: true,
      // findAllMatches: false,
      // minMatchCharLength: 1,
      // location: 0,
      // threshold: 0.6,
      // distance: 100,
      // useExtendedSearch: false,
      // ignoreLocation: false,
      // ignoreFieldNorm: false,
      keys: [
        "name",
      ]
    };

    const fuse = new Fuse(docs, options);
    const result = fuse.search(courseFilter)
    res.status(200).json(result.map(r => ({ ...r.item.toObject(), indices: r.matches })))
  } else {
    res.status(200).json(docs)
  }
});

router.delete('/courses/:courseId', (req, res) => {
  const email = req.userData.email
  const courseId = req.params.courseId

  oauth2Client.setCredentials(req.userData.tokens);
  CourseModel.findOne({ _id: courseId }).then((doc) => {
    const googleIds = doc.ids
    if (googleIds) {
      Promise.all(googleIds.filter(Boolean).map((id) => {
        return deleteEvent(oauth2Client, id)
      })).then(() => {
        CourseModel.deleteOne({ email, _id: courseId }).then((numRemoved) => {
          res.status(200).json(true);
        });
      });
    } else {
      CourseModel.deleteOne({ email, _id: courseId }).then((numRemoved) => {
        res.status(200).json(true);
      });
    }
  });
});

router.get('/rush', (req, res) => {
  const email = req.userData.email;
  const isLoadingRush = myCache.has(`loading-rush-${email}`);

  RushModel.findOne({ email }).then((doc) => {
    res.status(200).json({ rush: doc, isLoadingRush })
  });
});

router.post('/rush', (req, res) => {
  const email = req.userData.email;

  oauth2Client.setCredentials(req.userData.tokens);
  const { startDate, endDate, isDayRevision } = req.body;
  createRush(email, startDate, endDate, isDayRevision);

  res.status(200).json(true);
})

router.delete('/rush', (req, res) => {
  const email = req.userData.email
  myCache.set(`loading-rush-${email}`);
  
  oauth2Client.setCredentials(req.userData.tokens);
  RushModel.find({ email }).then((docs) => {
    const googleIds = docs.flatMap(doc => doc.ids)
    Promise.all(googleIds.filter(Boolean).map((id) => {
      return deleteEvent(oauth2Client, id)
    })).then(() => {
      RushModel.deleteMany({ email }).then((numRemoved) => {
        myCache.del(`loading-rush-${email}`);
      });
    });
  });

  res.status(200).json(true)
});

const notificationRequest = (email) => {
  const now = new Date();
  return { $or:[{ 'course.email': email, date: { $gte: now }, isOnPauseSince: null }, { 'course.email': email, isOnPauseSince: { $ne: null } }] }
}

router.post('/notifications/sub', (req, res) => {
  const email = req.userData.email
  const sub = req.body
  
  SubscriptionModel.countDocuments({ email, 'sub.endpoint': sub.endpoint }).then((count) => {
    if (count === 0) {
      const subscription = new SubscriptionModel({
        email,
        sub,
      })

      subscription.save().then(() => {
        res.status(200).json(true)
      });
    } else {
      res.status(200).json(true)
    }
  })
})

router.post('/notifications', (req, res) => {
  const email = req.userData.email
  const notifications = req.body;

  NotificationModel.deleteMany(notificationRequest(email)).then(() => {
    deleteInScheduler(email);
    for (let i = 0; i < notifications.length; ++i) {
      const notif = notifications[i];
      new NotificationModel(notif).save().then((newDoc) => {
        const j = scheduleNotif(newDoc)
        appendInScheduler(email, j);
      });
    }

    res.status(200).json(true)
  });
});

router.get('/notifications', (req, res) => {
  const email = req.userData.email
  NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).then((docs) => {
    res.status(200).json(docs);
  });
});

router.post('/notifications/pause', (req, res) => {
  const email = req.userData.email;
  const now = new Date(req.headers.now);
  NotificationModel.findOne(notificationRequest(email)).sort({ date: -1 }).then((doc) => {
    NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).then(async (notifications) => {
      const notifs = [];
      if (doc.isOnPauseSince && notifications.length) {
        const currentDate = moment(notifications[0].date);
        for (let index = 0; index < notifications.length; ++index) {
          const n = notifications[index];
          notifs.push({
            ...n._doc,
            date: index === 0
              ? currentDate.add(moment(now).diff(moment(doc.isOnPauseSince), 'seconds'), 'seconds').format()
              : currentDate.add(n.durationBefore, 'minutes').format(),
            isOnPauseSince: null,
          });
        }

        for (let i = 0; i < notifs.length; ++i) {
          const notif = notifs[i];
          await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { date: notif.date, isOnPauseSince: null });
        }
        
        for (let i = 0; i < notifs.length; ++i) {
          const notif = notifs[i];
          const j = scheduleNotif(notif);
          appendInScheduler(email, j);
        }
      } else {
        for (let index = 0; index < notifications.length; ++index) {
          const n = notifications[index];
          notifs.push({
            ...n._doc,
            isOnPauseSince: now,
          });
        }

        for (let i = 0; i < notifs.length; ++i) {
          const notif = notifs[i];
          await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { isOnPauseSince: now });
        }

        deleteInScheduler(email);
      }

      res.status(200).json(notifs);
    });
  });
});

router.delete('/notifications/:notificationId', (req, res) => {
  const email = req.userData.email
  const notificationId = req.params.notificationId
  const now = new Date(req.headers.now);

  NotificationModel.findOne({ 'course.email': email, _id: notificationId }).then((doc) => {
    const timeToDeleteInSecond = (doc.isOnPauseSince) ?
      moment(doc.date).diff(moment(doc.isOnPauseSince), 'seconds')
    :
      moment(doc.date).diff(moment(now), 'seconds')

    NotificationModel.deleteOne({ 'course.email': email, _id: notificationId }).then(() => {
      deleteInScheduler(email);
      
      NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).then(async (notifications) => {
        const notifs = [];

        if (notifications.length) {
          const currentDate = moment(notifications[0].date);

          for (let index = 0; index < notifications.length; ++index) {
            const n = notifications[index];
            notifs.push({
              ...n._doc,
              date: index === 0
                ? currentDate.subtract(timeToDeleteInSecond, 'seconds').format()
                : currentDate.add(n.durationBefore, 'minutes').format(),
            });
          }

          for (let index = 0; index < notifs.length; ++index) {
            const notif = notifs[index];
            await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { date: notif.date });
          }

          if (!doc.isOnPauseSince) {
            for (let index = 0; index < notifs.length; ++index) {
              const notif = notifs[index];
              const j = scheduleNotif(notif);
              appendInScheduler(email, j);
            }
          }
        }

        res.status(200).json(notifs);
      });
    });
  });
});

router.delete('/settings/we-revisions', (req, res) => {
  const email = req.userData.email

  myCache.set(`loading-setting-${email}`);

  oauth2Client.setCredentials(req.userData.tokens);
  WeekendRevisionModel.find({ 'course.email': email }).then((weRevisions) => {
    Promise.all(weRevisions.map(r => r.googleId).filter(Boolean).map((id) => {
      return new Promise((resolve, reject) => {
        resolve(deleteEvent(oauth2Client, id)
          .then(() => {
            WeekendRevisionModel.deleteOne({ 'course.email': email, googleId: id }).then(() => {});
          }));
      });
    })).then(() => {
      myCache.del(`loading-setting-${email}`);
    });
  });

  res.status(200).json(true);
});

router.get('/settings', (req, res) => {
  const email = req.userData.email
  const isLoadingSetting = myCache.has(`loading-setting-${email}`);
  SettingModel.findOne({ email }).then((doc) => {
    res.status(200).json({ settings: doc, isLoadingSetting });
  });
});

router.post('/settings', (req, res) => {
  const email = req.userData.email
  const maxCoursesNumber = req.body.maxCoursesNumber
  const endDate = req.body.endDate

  myCache.set(`loading-setting-${email}`);

  const startDate = moment.parseZone(req.headers.now).format('YYYY-MM-DD');

  let stillHaveTime = true;

  const momentEndDate = moment(endDate).set({ hour: 8, minute: 0, second: 0 });
  const start = getFirstSaturday(moment(startDate)).set({ hour: 8, minute: 0, second: 0 });
  const events = [];
  const coursesTooRecent = [];

  function addEventInArray(course, start, momentEndDate, courseInCurrentDay, maxCoursesNumber, events, courses) {
    const coursesNb = courses.filter(c => c.reminders.map(r => moment(r).format('YYYY-MM-DD')).includes(start.format('YYYY-MM-DD'))).length

    if (courseInCurrentDay + coursesNb >= maxCoursesNumber) {
      if (start.isoWeekday() === 7) {
        start.add(6, 'day').set({ hour: 8, minute: 0, second: 0 });
      } else {
        start.add(1, 'day').set({ hour: 8, minute: 0, second: 0 });
      }
      courseInCurrentDay = 0
    }

    const res = {
      summary: course.name,
      description: course.description,
      colorId: colors.PINK,
      start: {
        date: start.format('YYYY-MM-DD'),
        timeZone: 'Europe/Paris'
      },
      end: {
        date: moment(start).add(1, 'days').format('YYYY-MM-DD'),
        timeZone: 'Europe/Paris'
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 240 },
        ],
      },
    };

    if (start.isSameOrAfter(momentEndDate)) {
      return -1;
    }

    courseInCurrentDay += 1;
    events.push([course, res]);

    return courseInCurrentDay;
  }

  oauth2Client.setCredentials(req.userData.tokens);
  WeekendRevisionModel.find({ 'course.email': email }).then((weRevisions) => {
    Promise.all(weRevisions.map(r => r.googleId).filter(Boolean).map((id) => {
      return deleteEvent(oauth2Client, id)
    })).then(() => {
      WeekendRevisionModel.deleteMany({ 'course.email': email }).then((numRemoved) => {
        WorkDoneModel.find({ 'course.email': email, isFromWE: true }).then((worksDone) => {
          const idsToIgnore = worksDone.map(work => work.course._id)
          CourseModel.find({ email, _id: { $nin: idsToIgnore } }).then((courses) => {
            let courseInCurrentDay = 0;
            while (stillHaveTime) {
              for (let index = 0; index < courses.length; ++index) {
                const course = courses[index];
                if (!stillHaveTime) { return; }
                
                for (let i = 0; i < coursesTooRecent.length; ++i) {
                  const courseTooRecent = coursesTooRecent[i];
                  if (!stillHaveTime) { return; }
                  if (moment(courseTooRecent.date).add(15, 'days').isSameOrBefore(start)) {
                    const recentCourse = coursesTooRecent.shift();
                    courseInCurrentDay = addEventInArray(recentCourse, start, momentEndDate, courseInCurrentDay, maxCoursesNumber, events, courses)
                    if (courseInCurrentDay === -1) {
                      stillHaveTime = false
                      return null;
                    }
                  }
                }
                
                if (moment(course.date).add(15, 'days').isAfter(start)) {
                  coursesTooRecent.push(course)
                  return null;
                }
        
                courseInCurrentDay = addEventInArray(course, start, momentEndDate, courseInCurrentDay, maxCoursesNumber, events, courses)
        
                if (courseInCurrentDay === -1) {
                  stillHaveTime = false
                  return null;
                }
              }
            }
        
            Promise.all(events.map(([course, event], index) => {
              return new Promise((resolve, reject) => {
                resolve(insertEvents(oauth2Client, event)
                  .then((id) => {
                    const weekendRevision = new WeekendRevisionModel({
                      course,
                      date: event.start.date,
                      googleId: id,
                    });
        
                    weekendRevision.save().then(() => {});
                }));
              })
            })).then(() => {
              const query = { email: 'mathias.dominique123@gmail.com' };
              const update = { $set: { maxCoursesNumber }};
              const options = { upsert: true };
        
              SettingModel.updateOne(query, update, options).then(() => {
                myCache.del(`loading-setting-${email}`);
              });
            });
          });
        });
      });
    });
  });

  res.status(200).json(req.body);
});

router.get('/today-classes', (req, res) => {
  const email = req.userData.email
  const now = new Date(moment.parseZone(req.headers.now).format('YYYY-MM-DD'));

  WeekendRevisionModel.find({ 'course.email': email, date: now }).then((weRevisions) => {
    CourseModel.find({ email, reminders: now }).then((courses) => {
      const realCourses = weRevisions?.map(we => ({ ...we.toObject().course, isFromWE: true })).concat(courses || [])
      WorkDoneModel.find({ 'course.email': email, date: now }).then((docs) => {
        const docsAlreadySeenForTodayIds = docs?.map(doc => doc.course._id.toString()) || []
        res.status(200).json(realCourses?.filter(course => !docsAlreadySeenForTodayIds.includes(course._id.toString())) || []);
      });
    });
  });
});

router.post('/today-classes', (req, res) => {
  const now = new Date(moment.parseZone(req.headers.now).format('YYYY-MM-DD'));
  const email = req.userData.email

  oauth2Client.setCredentials(req.userData.tokens);
  WeekendRevisionModel.findOne({ 'course._id': req.body.course._id, date: now }).then((weRevision) => {
    CourseModel.findOne({ _id: req.body.course._id, email, reminders: now }).then((course) => {
      if (weRevision) {
        const googleId = weRevision.googleId
        patchEvents(oauth2Client, googleId, { colorId: colors.GREEN }).then(() => {
          const workDone = new WorkDoneModel({
            ...req.body,
            date: now,
            isFromWE: true,
          });
          
          workDone.save().then(() => {
            res.status(200).json(true)
          });
        })
      } else if (course) {
        if (course.ids) {
          const index = course.reminders.map(r => moment(r).format('YYYY-MM-DD')).indexOf(moment.parseZone(req.headers.now).format('YYYY-MM-DD'));
          const googleId = course.ids[index]
          patchEvents(oauth2Client, googleId, { colorId: colors.GREEN }).then(() => {
            const workDone = new WorkDoneModel({
              ...req.body,
              date: now,
              isFromWE: false,
            });
            
            workDone.save().then(() => {
              res.status(200).json(true)
            });
          })
        } else {
          const workDone = new WorkDoneModel({
            ...req.body,
            date: now,
            isFromWE: false,
          });
          
          workDone.save().then(() => {
            res.status(200).json(true)
          });
        }
      } else {
        res.status(403).json(false)
      }
    });
  });
});

function getFirstSaturday(startDate) {
  const dayINeed = 6;
  if (startDate.isoWeekday() <= dayINeed) {
    return startDate.isoWeekday(dayINeed);
  } else {
    return startDate.add(1, 'weeks').isoWeekday(dayINeed);
  }
}

const now = new Date();
NotificationModel.find({ date: { $gte: now }, isOnPauseSince: null }).then((notifs) => {
  if (!notifs?.length) return;

  for (let i = 0; i < notifs.length; ++i) {
    const notif = notifs[i];
    const j = scheduleNotif(notif);
    appendInScheduler(notif.course.email, j);
  }
});

function scheduleNotif(notif) {
  const date = new Date(notif.date)

  return schedule.scheduleJob(date, () => {
    const notificationPayload = {
      notification: {
        title: notif.course.name,
        body: notif.course.description,
        icon: "assets/icons/icon-128x128.png",
        vibrate: [500,110,500,110,450,110,200,110,170,40,450,110,200,110,170,40,500],
        data: {
          dateOfArrival: Date.now(),
          primaryKey: 1
        },
        actions: [{
          action: "nextCourse",
          title: "Voir le cours suivant"
        }],
      },
    }

    new Promise((resolve, reject) => {
      SubscriptionModel.find({ email: notif.course.email }).then((docs) => {
        for (let i = 0; i < docs.length; ++i) {
          const doc = docs[i];
          resolve(webpush.sendNotification(doc.sub, JSON.stringify(notificationPayload)));
        }
      });
    })
    .then(() => {
      console.log('Notification sent')
    })
    .catch(err => {
      console.error("Error sending notification, reason: ", err)
    })
  })
}

function appendInScheduler(email, j) {
  if (schedulers.hasOwnProperty(email)) {
    schedulers[email].push(j);
  } else {
    schedulers[email] = [];
    schedulers[email].push(j);
  }
}

function deleteInScheduler(email) {
  if (schedulers.hasOwnProperty(email)) {
    for (let i = 0; i < schedulers[email].length; ++i) {
      const j = schedulers[email][i];
      j.cancel()
    }
    delete schedulers[email];
  }
}

app.use((req, res, next) => {
  const token = req.headers.token

  if (token) {
    if (req.url === '/api/refresh-token') {
      next();
    } else {
      const tokenData = myCache.get(token);
      if (!tokenData) {
        return res.status(403).send({ name: "TokenExpiredError" });
      } else {
        req.userData = tokenData;
        next();
      }
    }
  } else {
    const isBeforeLogin = req.url === '/api/login' || req.url === '/api/sign-in'
    if (isBeforeLogin) {
      next();
    } else {
      return res.status(403).send('No token');
    }
  }
});

app.use(bodyParser.json());
app.use('/api', router);  // path must route to lambda

app.set('port', PORT);

app.listen(PORT, () => console.log(`Local app listening on port ${PORT}!`));
