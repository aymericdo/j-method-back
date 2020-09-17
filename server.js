'use strict';
const express = require('express');
const webpush = require('web-push');
const app = express();
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const cors = require('cors')
require('dotenv').config()
const mongoose = require('mongoose');
const moment = require('moment');

const router = express.Router();

const uri = process.env.MONGODB_URI;
const client = mongoose.createConnection(uri, { useNewUrlParser: true, useUnifiedTopology: true });

const CourseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: false },
  email: { type: String, required: true },
  difficulties: { type: String, required: true },
  date: { type: Date, required: true },
  ids: { type: [String], required: false },
});
const NotificationSchema = new mongoose.Schema({
  course: { type: CourseSchema, required: true },
  date: { type: Date, required: true },
  durationBefore: { type: Number, required: true },
  isOnPauseSince: { type: Date, required: false },
});
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

const CourseModel = client.model('courses', CourseSchema);
const NotificationModel = client.model('notifications', NotificationSchema);
const SubscriptionModel = client.model('subscriptions', SubscriptionSchema);

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

app.use(cors());
app.use(express.json({
    type: ['application/json', 'text/plain']
}));

router.post('/courses', (req, res) => {
  const email = req.headers.email
  const course = new CourseModel({
    email,
    ...req.body,
  });

  course.save(err => {
    res.status(200).json(course)
    mongoose.connection.close();
  })
})

router.get('/courses', (req, res) => {
  const email = req.headers.email

  CourseModel.find({ email }, (err, docs) => {
    res.status(200).json(docs)
  })
})

router.delete('/courses/:courseId', (req, res) => {
  const email = req.headers.email
  const courseId = req.params.courseId

  CourseModel.deleteOne({ email, _id: courseId }, (err, numRemoved) => {
    res.status(200).json(true)
  })
})

const notificationRequest = (email) => {
  const now = new Date();
  return { $or:[{ 'course.email': email, date: { $gte: now }, isOnPauseSince: null }, { 'course.email': email, isOnPauseSince: { $ne: null } }] }
}


router.post('/notifications/sub', (req, res) => {
  const email = req.headers.email
  const sub = req.body
  
  SubscriptionModel.countDocuments({ email, 'sub.endpoint': sub.endpoint }, function (err, count) {
    if (count === 0) {
      const subscription = new SubscriptionModel({
        email,
        sub,
      })

      subscription.save(() => {
        res.status(200).json(true)
      });
    } else {
      res.status(200).json(true)
    }
  })
})

router.post('/notifications', (req, res) => {
  const email = req.headers.email
  const notifications = req.body;
  const now = new Date();

  NotificationModel.deleteMany(notificationRequest(email), (err) => {
    deleteInScheduler(email);
    notifications.forEach((notif) => {
      new NotificationModel(notif).save((err, newDoc) => {
        const j = scheduleNotif(newDoc)
        appendInScheduler(email, j);
      });
    });

    res.status(200).json(true)
  });
});

router.get('/notifications', (req, res) => {
  const email = req.headers.email
  NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).exec((err, docs) => {
    res.status(200).json(docs);
  });
});

router.post('/notifications/pause', (req, res) => {
  const email = req.headers.email;
  const now = new Date(req.headers.now);
  NotificationModel.findOne(notificationRequest(email)).sort({ date: -1 }).exec((err, doc) => {
    NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).exec((err, notifications) => {
      const notifs = [];
      if (doc.isOnPauseSince && notifications.length) {
        const currentDate = moment(notifications[0].date);
        notifications.forEach((n, index) => {
          notifs.push({
            ...n._doc,
            date: index === 0
              ? currentDate.add(moment(now).diff(moment(doc.isOnPauseSince), 'seconds'), 'seconds').format()
              : currentDate.add(n.durationBefore, 'minutes').format(),
            isOnPauseSince: null,
          });
        });

        notifs.forEach(async notif => {
          await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { date: notif.date, isOnPauseSince: null });
        });
        
        notifs.forEach((notif) => {
          const j = scheduleNotif(notif);
          appendInScheduler(email, j);
        });
      } else {
        notifications.forEach(n => {
          notifs.push({
            ...n._doc,
            isOnPauseSince: now,
          });
        });

        notifs.forEach(async notif => {
          await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { isOnPauseSince: now });
        });

        deleteInScheduler(email);
      }

      res.status(200).json(notifs);
    });
  });
});

router.delete('/notifications/:notificationId', (req, res) => {
  const email = req.headers.email
  const notificationId = req.params.notificationId
  const now = new Date(req.headers.now);

  NotificationModel.findOne({ 'course.email': email, _id: notificationId }, (err, doc) => {
    const diff = (doc.isOnPauseSince) ?
      moment(doc.date).diff(moment(doc.isOnPauseSince), 'seconds')
    :
      moment(doc.date).diff(moment(now), 'seconds')

    NotificationModel.deleteOne({ 'course.email': email, _id: notificationId }, (err) => {
      deleteInScheduler(email);
      
      NotificationModel.find(notificationRequest(email)).sort({ date: 1 }).exec((err, notifications) => {
        const currentDate = moment(notifications[0].date);
        const notifs = [];

        notifications.forEach((n, index) => {
          notifs.push({
            ...n._doc,
            date: index === 0
              ? currentDate.subtract(diff, 'seconds').format()
              : currentDate.add(n.durationBefore, 'minutes').format(),
          });
        });

        notifs.forEach(async notif => {
          await NotificationModel.updateOne({ 'course.email': email, _id: notif._id }, { date: notif.date });
        });

        if (!doc.isOnPauseSince) {
          notifs.forEach((notif) => {
            const j = scheduleNotif(notif);
            appendInScheduler(email, j);
          });
        }

        res.status(200).json(notifs);
      });
    });
  });
});

const now = new Date();
NotificationModel.find({ date: { $gte: now }, isOnPauseSince: null }, (err, notifs) => {
  if (!notifs.length) return;

  notifs.forEach((notif) => {
    const j = scheduleNotif(notif);
    appendInScheduler(notif.course.email, j);
  });
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
      SubscriptionModel.find({ email: notif.course.email }, (err, docs) => {
        docs.forEach((doc) => {
          resolve(webpush.sendNotification(doc.sub, JSON.stringify(notificationPayload)));
        });
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
    schedulers[email].forEach(j => j.cancel());
    delete schedulers[email];
  }
}

app.use((req, res, next) => {
  if (!req.headers.email) {
    res.sendStatus(401);
  } else {
    next();
  }
});

app.use(bodyParser.json());
app.use('/api', router);  // path must route to lambda

app.listen(process.env.PORT || 3000, () => console.log(`Local app listening on port ${process.env.PORT || 3000}!`));
