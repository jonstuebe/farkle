import React, { Component } from 'react';
import { Row, Col, Jumbotron, Button, ListGroup, ListGroupItem, Input } from 'react-bootstrap';

import { Link } from 'react-router';

class App extends Component {
  render() {
    return (
      <div>
        <NavBar />
        <div className="container">
          <Row>
            <Col xs={12}>
              <Jumbotron>
                <h2>Meeting Notes</h2>
              <p>To get started click below to either start a new meeting, join an existing meeting, or open an old meeting.</p>
                <Button bsStyle="primary">New Meeting</Button>
              </Jumbotron>
            </Col>
          </Row>
          <Row>
            <Col xs={12}>

              <h2>Active Meetings:</h2>
              <ListGroup>
                <ListGroupItem href="#">Adipiscing Tellus Condimentum</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
              </ListGroup>

              <h2>Recent Meetings:</h2>

              <ListGroup>
                <ListGroupItem href="#">Adipiscing Tellus Condimentum</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
              </ListGroup>

              <h2>Archived Meetings:</h2>

              <ListGroup>
                <ListGroupItem href="#">Adipiscing Tellus Condimentum</ListGroupItem>
                <ListGroupItem href="#">Ligula Malesuada Adipiscing Justo Fusce</ListGroupItem>
              </ListGroup>
            </Col>
          </Row>
        </div>
      </div>
    )
  }
}

export default App