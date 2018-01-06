﻿var express = require("express"),
    fs = require("fs"),
    path = require("path"),
    querystring = require('querystring'),
    passport = require("passport"),
    localStrategy = require("passport-local").Strategy,
    svgCaptcha = require("svg-captcha"),
    middleware = require("./middleware.js"),
    formatting = require("./formatting.js");

var config, database, sitePages;

var restrictedRoute = middleware.restrictedRoute;
var urlencodedParser = middleware.bodyParser;
var server = express.Router();

passport.use("local", new localStrategy({ usernameField: "username", passwordField: "password" }, function (username, password, cb) {
    database.userByName(username, function (err, user) {
        if (err) { return cb(err); }
        if (!user) { return cb(null, false); }
        var givenPassword = formatting.sha256(password + (user.Salt || ""));
        if (user.Password != givenPassword) {
            return cb(null, false);
        }
        return cb(null, user);
    });
}));
passport.serializeUser(function (user, cb) {
    // UInt8Arrays don't take to the DB well, so mangle first
    cb(null, user.UserID.toString("hex"));
});
passport.deserializeUser(function (id, cb) {
    database.userById(formatting.hexToBin(id), function (err, user) {
        if (err) { return cb(err); }
        cb(null, user);
    });
});

server.use(passport.initialize());
server.use(passport.session());
// HACK: Copied here until passport is moved back to main router
server.use(function (req, res, next) {
    res.locals.user = req.user;
    next();
});

// Auth routes
server.get("/user/login", function (req, res) {
    if (req.user) {
        return res.redirect(req.get("Referrer") || "/home");
    } else {
        return res.render("login", {
            target: req.query.target
        });
    }
});

server.post("/user/login", urlencodedParser, function (req, res) {
    passport.authenticate("local", function (err, user, info) {
        if (err) {
            console.log(err);
            req.flash("danger", "There was an error authenticating.");
            return res.status(500).render("login", {
                target: req.query.target
            });
        }
        // if user is not found due to wrong username or password
        if (!user) {
            req.flash("danger", "Invalid username or password.");
            return res.status(400).render("login", {
                target: req.query.target
            });
        }
        if (user.AccountEnabled == "False") {
            req.flash("danger", "Your account has been disabled.");
            return res.status(400).render("login", {
                target: req.query.target
            });
        }
        //passport.js has a logIn user method
        req.logIn(user, function (err) {
            if (err) {
                console.log(err);
                req.flash("danger", "There was an error authenticating.");
                return res.status(500).render("login", {
                    target: req.query.target
                });
            }
            database.userUpdateLastSeenTime(user.UserID, function (lsErr) {
                req.flash("warning", "Your last login time couldn't be updated.");
            });
            // The user has an insecure password and should change it.
            if (!user.Salt) {
                req.flash("warning", "Your password was stored in an insecure way - you need to <a href='/user/edit'>update it</a>.");
            }
            return res.redirect(req.query.target || "/home");
        });
    })(req, res);
});

server.get("/user/logout", function (req, res) {
    req.logout();
    return res.redirect("/home");
});

// TODO: Refactor these routes for admins to edit other profiles
// They could use SQL for now, but as we extend, that's infeasible
server.get("/user/edit", restrictedRoute(), function (req, res) {
    return res.render("editProfile");
});

server.post("/user/changepw", restrictedRoute(), urlencodedParser, function (req, res) {
    if (req.body && req.body.password && req.body.newPassword && req.body.newPasswordR) {
        if (formatting.sha256(req.body.password + (req.user.Salt || "")) == req.user.Password) {
            if (req.body.newPassword == req.body.newPasswordR) {
                database.userChangePassword(req.user.UserID, req.body.newPassword, function (pwErr) {
                    if (pwErr) {
                        req.flash("danger", "There was an error changing your password.");
                        return res.status(500).render("editProfile");
                    } else {
                        req.flash("success", "Your password change was a success!");
                        return res.render("editProfile");
                    }
                });
            } else {
                req.flash("danger", "The new passwords don't match.");
                return res.status(400).render("editProfile");
            }
        } else {
            req.flash("danger", "The current password given was incorrect.");
            return res.status(403).render("editProfile");
        }
    } else {
        req.flash("danger", "The request was malformed.");
        return res.status(400).render("editProfile");
    }
});

server.post("/user/edit", restrictedRoute(), urlencodedParser, function (req, res) {
    // TODO: Extend as we extend editable profile options (none for now)
    if (req.body && req.body.email) {
        // HACK: nasty way to demangle UInt8Array
        var id = formatting.hexToBin(req.user.UserID.toString("hex"));
        database.execute("SELECT * FROM `Users` WHERE `Email` = ?", [req.body.email], function (slErr, slRes, slFields) {
            if (slRes.length > 0 && slRes[0].UserID.toString("hex") != req.user.UserID.toString("hex")) {
                req.flash("danger", "The email is in use.");
                return res.status(400).render("editProfile");
            }
            database.execute("UPDATE Users SET Email = ? WHERE UserID = ?", [config.usersCanEditEmail ? req.body.email : req.user.Email, id], function (pwErr, pwRes, pwFields) {
                if (pwErr) {
                    req.flash("danger", "There was an error changing your profile.");
                    return res.status(500).render("editProfile");
                } else {
                    req.flash("success", "Your profile change was a success!");
                    return res.render("editProfile");
                }
            });
        });
    } else {
        req.flash("danger", "The request was malformed.");
        return res.status(400).render("editProfile");
    }
});

function signupPage(req, res, status, message) {
    var captcha = svgCaptcha.create({ size: 6, noise: 2 });
    req.session.captcha = captcha;

    if (message)
        req.flash("danger", message);

    return res.status(status || 200).render("signup", {
        captcha: captcha.data,
    });
}

server.get("/user/signup", function (req, res) {
    return signupPage(req, res, null, null);
});

server.post("/user/signup", urlencodedParser, function (req, res) {
    if (req.body && req.body.username && req.body.password && req.body.captcha && req.body.email) {
        if (/^[A-Za-z0-9-_ ]{4,32}$/.test(req.body.username) == false) {
            return signupPage(req, res, 400, "The username is invalid.");
        }
        if (req.body.captcha == req.session.captcha.text) {
            // check for username existence
            database.execute("SELECT * FROM `Users` WHERE `ShortName` = ? OR `Email` = ?", [req.body.username, req.body.email], function (slErr, slRes, slFields) {
                if (slErr) {
                    return signupPage(req, res, 500, "There was an error checking the database.");
                } else if (slRes.length > 0) {
                    return signupPage(req, res, 400, "There is already a user with that name or email address.");
                } else {
                    var salt = formatting.createSalt();
                    var password = formatting.sha256(req.body.password + salt);
                    database.execute("INSERT INTO `Users` (`ShortName`, `Email`, `Password`, `Salt`, `RegistrationIP`) VALUES (?, ?, ?, ?, ?)", [req.body.username, req.body.email, password, salt, req.ip], function (inErr, inRes, inFields) {
                        if (inErr) {
                            return signupPage(req, res, 500, "There was an error creating your account.");
                        } else {
                            req.flash("success", "Your account has been successfully made. You can log in now.");
                            res.redirect("/user/login");
                        }
                    });
                }
            });
        } else {
            return signupPage(req, res, 400, "The captcha failed verification.");
        }
    } else {
        return signupPage(req, res, 400, "The request was malformed.");
    }
});

server.get("/user/vanillaSSO", function (req, res) {
    if (!config.useVanilla) {
        // no reason for this if disabled
        return res.sendStatus(404);
    }

    if (req.query.client_id != config.vanillaClientId) {
        return res.send(req.query.callback + "(" + JSON.stringify({
            error: "invalid_client",
            message: "Client ID does not match.",
        }) + ")");
    }

    if (req.query.timestamp == null) {
        // send stub as recommended?
    } else if (Number(req.query.timestamp) - 300 > Date.now() &&
        formatting.sha256(req.query.timestamp + config.vanillaSecret) != req.query.signature) {
        return res.send(req.query.callback + "(" + JSON.stringify({
            error: "invalid_signature",
            message: "Signature does not match.",
        }) + ")");
    }

    var builtObject;

    if (req.user && req.query.timestamp != null) {
        // built pre-sorted array
        builtObject = {
            email: req.user.Email,
            name: req.user.ShortName,
            roles: "member",
            uniqueid: formatting.binToHex(req.user.UserID),
        };
        if (req.user.UserFlags.some(function (x) { return x.FlagName == "vip"; })) {
            builtObject.roles += ",VIP";
        }
        if (req.user.UserFlags.some(function (x) { return x.FlagName == "sa"; })) {
            builtObject.roles += ",administrator";
        }
        // for crypto's sake
        // WARNING: Vanilla uses behaviour that DOES NOT match JavaScript stringify,
        // set line 148 of functions.jsconnect.php to:
        // $String = http_build_query($Data, NULL, '&', PHP_QUERY_RFC3986);
        var qs = querystring.stringify(builtObject);
        // append items that dont need to be signed/sorted
        builtObject.client_id = config.vanillaClientId;
        builtObject.signature = formatting.sha256(qs + config.vanillaSecret);
    } else if (req.user) {
        // build a stub for authed but not signed
        builtObject = {
            name: req.user.ShortName
        };
    } else {
        // nothin'
        builtObject = {
            name: ""
        };
    }
    res.send(req.query.callback + "(" + JSON.stringify(builtObject) + ")");
});

module.exports = function (c, d, p) {
    config = c
    database = d;
    sitePages = p;
    
    // init user flags once we're connected
    database.populateUserFlags();

    return server;
}