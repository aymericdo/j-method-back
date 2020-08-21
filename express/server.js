'use strict';

const express = require('express');
const path = require('path');
const webpush = require('web-push');
const serverless = require('serverless-http');
const app = express();
const Datastore = require('nedb');
const bodyParser = require('body-parser');

const db = {};
db.courses = new Datastore({ filename: 'data/db-courses.json' });
db.notifications = new Datastore({ filename: 'data/db-notifications.json' });
db.subscriptions = new Datastore({ filename: 'data/db-subscriptions.json' });
db.courses.loadDatabase();
db.notifications.loadDatabase();
db.subscriptions.loadDatabase();

const vapidKeys = {
  publicKey: "BA0IrWNjeSUg-vrORw1qaiMZ4-echF259O25I42NywBlbC3f7OzdiJjooH27nOzjtID5EoQ4pZO1wOo7lzwi7iQ",
  privateKey:"Wev87nA92dTFhnr9HFTTDDS7zE-4GMtuxFHS8NokVCU",
};

webpush.setVapidDetails(
  'mailto:aymeric.dominique@gmail.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

const router = express.Router();
router.post('/api/courses', (req, res) => {
  const email = req.headers.email
  const course = {
    email,
    ...req.body,
  }
  db.courses.insert(course, (err, newDoc) => {
    res.status(200).json(course)
  })
})

router.get('/api/courses', (req, res) => {
  const email = req.headers.email

  db.courses.find({ email }, (err, docs) => {
    res.status(200).json(docs)
  })
})

router.delete('/api/courses/:courseId', (req, res) => {
  const email = req.headers.email
  const courseId = req.params.courseId

  db.courses.remove({ email, _id: courseId }, (err, numRemoved) => {
    res.status(200).json(true)
  })
})

router.post('/api/notifications/sub', (req, res) => {
  const email = req.headers.email
  const sub = req.body
  
  db.subscriptions.count({ email, 'sub.endpoint': sub.endpoint }, function (err, count) {
    if (count === 0) {
      db.subscriptions.insert({
        email,
        sub,
      })
    }
    res.status(200).json(true)
  })
})

router.post('/api/notifications', (req, res) => {
  const email = req.headers.email
  const notifications = req.body

  db.subscriptions.find({ email }, (err, docs) => {
    docs.forEach(doc => {
      notifications.forEach((notif) => {
        db.notifications.insert(notif, (err, newDoc) => {
          const j = scheduleNotif(doc.sub, newDoc)
          console.log(j)
        })
      })
    })
  })

  res.status(200).json(true)
})

router.get('/api/notifications', (req, res) => {
  const email = req.headers.email
  db.notifications.find({ 'course.email': email }).sort({ date: 1 }).exec((err, docs) => {
    res.status(200).json(docs)
  })
})

router.delete('/api/notifications/:notificationId', (req, res) => {
  const email = req.headers.email
  const notificationId = req.params.notificationId
  db.notifications.remove({ 'course.email': email, _id: notificationId }, (err, numRemoved) => {
    res.status(200).json(true)
  })
  // j.cancel()
});

db.notifications.find({}, (err, notifs) => {
  if (!notifs.length) return

  db.subscriptions.find({ email: notifs[0].course.email }, (err, docs) => {
    notifs.forEach((notif) => {
      docs.forEach((doc) => {
        scheduleNotif(doc.sub, notif)
      })
    })
  });
});

function scheduleNotif(sub, notif) {
  const date = new Date(notif.date)

  return schedule.scheduleJob(date, () => {
    const notificationPayload = {
      notification: {
        title: notif.course.name,
        body: notif.course.description,
        icon: "assets/main-page-logo-small-hat.png",
        vibrate: [100, 50, 100],
        data: {
          dateOfArrival: Date.now(),
          primaryKey: 1
        },
        actions: [{
          action: "explore",
          title: "Go to the site"
        }],
      },
    }

    new Promise((resolve, reject) => {
      resolve(webpush.sendNotification(sub, JSON.stringify(notificationPayload)))
    })
    .then(() => {
      console.log('Notification sent')
    })
    .catch(err => {
      console.error("Error sending notification, reason: ", err)
    })
  })
}

router.use((req, res, next) => {
  if (!req.headers.email) {
    res.sendStatus(401);
  } else {
    next();
  }
});

app.use(bodyParser.json());
app.use('/.netlify/functions/server', router);  // path must route to lambda
app.use('/', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

module.exports = app;
module.exports.handler = serverless(app);
