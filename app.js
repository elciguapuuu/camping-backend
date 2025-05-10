//master config of the api
const createError = require('http-errors');
const express = require('express');
const session = require('express-session');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const multer = require('multer');
const db = require('./config/db');
const cors = require('cors');
const passport = require('./config/passport');
const bodyParser = require('body-parser');

// Import routes
const indexRouter = require('./routes/index');
const usersRouter = require('./routes/users');
const authRouter = require('./routes/auth');
const locationsRouter = require('./routes/locations');
const bookingsRouter = require('./routes/bookings');
const reviewsRouter = require('./routes/reviews');
const imagesRouter = require('./routes/images');
const paymentsRouter = require('./routes/payments'); // Add this line


const app = express();
const PORT = process.env.PORT || 3001;

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(session({
  secret: process.env.SESSION_SECRET || 'your_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

app.use(logger('dev'));
app.use(cors()); 
app.use(express.json());
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log('Request Body:', req.body);
  console.log('Headers:', req.headers);
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads/images', express.static(path.join(__dirname, 'uploads', 'images')));
app.use(passport.initialize());
app.use(passport.session());

// Define routes
app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/auth', authRouter);
app.use('/locations', locationsRouter);
app.use('/bookings', bookingsRouter);
app.use('/reviews', reviewsRouter);
app.use('/images', imagesRouter);
app.use('/api/payments', paymentsRouter); // Add this line


//testing db
app.get('/test-db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM Users');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// catch 404 and forward to error handler
app.use((req, res, next) => {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

//set up server 

console.log(app._router.stack.map(r => r.route && r.route.path));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;

