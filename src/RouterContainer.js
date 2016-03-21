import React, { Component } from 'react';

import { createHistory, useBasename } from 'history';
import { Router, Route, Link } from 'react-router';

import App from './App';

const history = useBasename(createHistory)({
  basename: ''
})

class RouterContainer extends Component {
    render() {
      return (
        <Router history={history}>
          <Router path="/" component={App}>
          </Router>
        </Router>
      )
    }
}

export default RouterContainer
