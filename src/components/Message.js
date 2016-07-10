import React from 'react';

const Message = React.createClass({
    render() {
        return (
            <div className="message">
                {this.props.children}
            </div>
        )
    }
});

export default Message;
