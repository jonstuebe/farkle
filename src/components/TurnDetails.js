import React, { PropTypes } from 'react'

const TurnDetails = React.createClass({
    render () {
        return (
            <div className="turn-details">
                <div className="turn-details__total">
                    <h2>Total</h2>
                    <h3>{this.props.total}</h3>
                </div>
            </div>
        );
    }
})

export default TurnDetails
